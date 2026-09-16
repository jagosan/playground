#!/usr/bin/env python3
"""
ingest_repo_symbols_to_neo4j.py - Knowledge Graph Symbol Ingestion for Homelab & Repositories.

Parses docs/MAP.md (macro architecture, modules, REST endpoints) and source trees (TypeScript, Python)
and ingests structural relationships into the Beehive Neo4j instance.

Part of SPEC-HL-014 / TASK-HL-123c.
"""

import os
import sys
import re
import json
import ast
import argparse
import urllib.request
from typing import List, Dict, Any, Tuple, Optional

DEFAULT_TAILSCALE_IP = "100.99.188.15"
DEFAULT_NEO4J_URL = f"http://{DEFAULT_TAILSCALE_IP}:7474/db/neo4j/tx/commit"


def run_cypher(neo4j_url: str, statements: List[Dict[str, Any]]) -> Tuple[bool, Any]:
    """Execute Cypher statements natively against Neo4j HTTP transactional endpoint."""
    payload = {"statements": statements}
    req_body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        neo4j_url,
        data=req_body,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            res_data = json.loads(res.read().decode("utf-8"))
            if res_data.get("errors"):
                return False, f"Neo4j Errors: {res_data['errors']}"
            return True, res_data.get("results", [])
    except Exception as e:
        return False, str(e)


# ── Symbol Extractors ─────────────────────────────────────────────────────────

def extract_ts_symbols(file_path: str, repo_name: str) -> Dict[str, List[Dict[str, Any]]]:
    """Extract interfaces, classes, types, and functions from TypeScript/JS files."""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception:
        return {}

    rel_path = os.path.relpath(file_path, os.getcwd())
    symbols: Dict[str, List[Dict[str, Any]]] = {
        "interfaces": [],
        "classes": [],
        "types": [],
        "functions": [],
    }

    # 1. Interfaces
    if_pattern = re.compile(r'^(export\s+)?interface\s+([A-Za-z0-9_$]+)(<[^>]+>)?(\s+extends\s+([^{]+))?\s*\{', re.MULTILINE)
    for m in if_pattern.finditer(content):
        name = m.group(2)
        extends = (m.group(5) or "").strip()
        brace_count = 0
        end_pos = -1
        for i in range(m.end() - 1, len(content)):
            if content[i] == '{':
                brace_count += 1
            elif content[i] == '}':
                brace_count -= 1
                if brace_count == 0:
                    end_pos = i + 1
                    break
        body = content[m.end():end_pos - 1] if end_pos != -1 else ""
        props = []
        for line in body.splitlines():
            line = line.strip()
            if line and not line.startswith("//") and not line.startswith("/*") and ":" in line:
                p = line.rstrip(";,")
                if len(p) < 80:
                    props.append(p)
        symbols["interfaces"].append({
            "name": name,
            "extends": extends,
            "fields": ", ".join(props[:8]) + ("..." if len(props) > 8 else ""),
            "file": rel_path,
            "repo": repo_name,
        })

    # 2. Classes
    class_pattern = re.compile(r'^(export\s+(default\s+)?)?class\s+([A-Za-z0-9_$]+)(<[^>]+>)?(\s+extends\s+([A-Za-z0-9_$.< >]+))?(\s+implements\s+([A-Za-z0-9_$,.< >]+))?\s*\{', re.MULTILINE)
    for m in class_pattern.finditer(content):
        name = m.group(3)
        extends = (m.group(6) or "").strip()
        implements = (m.group(8) or "").strip()
        brace_count = 0
        end_pos = -1
        for i in range(m.end() - 1, len(content)):
            if content[i] == '{':
                brace_count += 1
            elif content[i] == '}':
                brace_count -= 1
                if brace_count == 0:
                    end_pos = i + 1
                    break
        body = content[m.end():end_pos - 1] if end_pos != -1 else ""
        methods = []
        method_regex = re.compile(r'^\s*(public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z0-9_$]+)\s*\(([^)]*)\)(\s*:\s*[^{;]+)?\s*\{', re.MULTILINE)
        for mm in method_regex.finditer(body):
            m_name = mm.group(2)
            if m_name in ("if", "for", "while", "switch", "catch"):
                continue
            ret = (mm.group(4) or "").strip().lstrip(": ")
            ret_str = f": {ret}" if ret else ""
            methods.append(f"{m_name}(){ret_str}")
        symbols["classes"].append({
            "name": name,
            "extends": extends,
            "implements": implements,
            "methods": ", ".join(methods[:8]) + ("..." if len(methods) > 8 else ""),
            "file": rel_path,
            "repo": repo_name,
        })

    # 3. Types
    type_pattern = re.compile(r'^(export\s+)?type\s+([A-Za-z0-9_$]+)(<[^>]+>)?\s*=\s*([^;]+);', re.MULTILINE)
    for m in type_pattern.finditer(content):
        name = m.group(2)
        defn = m.group(4).strip().replace("\n", " ")
        defn = re.sub(r'\s+', ' ', defn)
        symbols["types"].append({
            "name": name,
            "definition": defn[:120],
            "file": rel_path,
            "repo": repo_name,
        })

    # 4. Functions
    func_pattern = re.compile(r'^(export\s+(default\s+)?)?(async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)(\s*:\s*[^{;]+)?\s*\{', re.MULTILINE)
    for m in func_pattern.finditer(content):
        name = m.group(4)
        params = m.group(5).strip()
        ret = (m.group(6) or "").strip()
        sig = f"{name}({params}){ret}"
        symbols["functions"].append({
            "name": name,
            "signature": sig[:150],
            "file": rel_path,
            "repo": repo_name,
        })

    return symbols


def extract_py_symbols(file_path: str, repo_name: str) -> Dict[str, List[Dict[str, Any]]]:
    """Extract classes and functions from Python files using standard library ast."""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        tree = ast.parse(content)
    except Exception:
        return {}

    rel_path = os.path.relpath(file_path, os.getcwd())
    symbols: Dict[str, List[Dict[str, Any]]] = {
        "classes": [],
        "functions": [],
    }

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            methods = []
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods.append(f"{item.name}()")
            bases = [ast.unparse(b) for b in node.bases] if node.bases else []
            doc = ast.get_docstring(node)
            summary = doc.strip().split("\n")[0] if doc else ""
            symbols["classes"].append({
                "name": node.name,
                "extends": ", ".join(bases),
                "implements": "",
                "methods": ", ".join(methods[:8]) + ("..." if len(methods) > 8 else ""),
                "description": summary,
                "file": rel_path,
                "repo": repo_name,
            })
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            doc = ast.get_docstring(node)
            summary = doc.strip().split("\n")[0] if doc else ""
            args_list = [a.arg for a in node.args.args if a.arg != "self"]
            sig = f"{node.name}({', '.join(args_list)})"
            symbols["functions"].append({
                "name": node.name,
                "signature": sig[:150],
                "description": summary,
                "file": rel_path,
                "repo": repo_name,
            })

    return symbols


def parse_map_md(map_path: str, repo_name: str) -> Dict[str, List[Dict[str, str]]]:
    """Parse structural symbols and endpoints from docs/MAP.md."""
    if not os.path.exists(map_path):
        return {"modules": [], "endpoints": []}

    modules = []
    endpoints = []
    seen_mod_paths = set()

    try:
        with open(map_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        for line in lines:
            line_s = line.strip()
            # Endpoint: - `GET /api/path`: description OR - GET /api/path: description
            m_ep = re.match(r'^\s*-\s+`?(GET|POST|PUT|DELETE|PATCH)\s+([^:`]+)`?:\s*(.+)$', line_s)
            if m_ep:
                endpoints.append({
                    "method": m_ep.group(1).upper(),
                    "path": m_ep.group(2).strip(),
                    "description": m_ep.group(3).strip(),
                    "repo": repo_name,
                })
                continue

            # Module pattern 1: - `path`: description
            m_mod1 = re.match(r'^\s*-\s+`([^`]+)`:\s*(.+)$', line_s)
            if m_mod1:
                p = m_mod1.group(1).strip()
                if p not in seen_mod_paths:
                    seen_mod_paths.add(p)
                    modules.append({
                        "name": os.path.basename(p),
                        "path": p,
                        "description": m_mod1.group(2).strip(),
                        "repo": repo_name,
                    })
                continue

            # Module pattern 2: ### `path` — description
            m_mod2 = re.match(r'^###?\s+`([^`]+)`\s*([—-]\s*(.+))?$', line_s)
            if m_mod2:
                p = m_mod2.group(1).strip()
                if p not in seen_mod_paths:
                    seen_mod_paths.add(p)
                    desc = (m_mod2.group(3) or "").strip()
                    modules.append({
                        "name": os.path.basename(p),
                        "path": p,
                        "description": desc,
                        "repo": repo_name,
                    })

    except Exception as e:
        print(f"Warning parsing MAP.md in {repo_name}: {e}")

    return {"modules": modules, "endpoints": endpoints}


# ── Ingestion Pipeline ────────────────────────────────────────────────────────

def ingest_repository(repo_dir: str, neo4j_url: str = DEFAULT_NEO4J_URL, macro_only: bool = False) -> bool:
    """Ingest a repository's MAP.md and symbols into Neo4j."""
    repo_name = os.path.basename(os.path.abspath(repo_dir))
    mode_str = "Macro Architecture Only (MAP.md & Endpoints)" if macro_only else "Full Symbol Tree (MAP.md + AST)"
    print(f"=== Ingesting '{repo_name}' into Neo4j [{mode_str}] ===")
    print(f"Target Directory: {os.path.abspath(repo_dir)}")
    print(f"Neo4j Endpoint:   {neo4j_url}")

    # Test Neo4j connection
    ok, _ = run_cypher(neo4j_url, [{"statement": "RETURN 1 as ping"}])
    if not ok:
        print(f"Error: Could not reach Neo4j at {neo4j_url}. Ingestion aborted.")
        return False

    statements = []

    # 1. Merge Repository Node
    statements.append({
        "statement": """
            MERGE (r:Repository {name: $repo})
            ON CREATE SET r.path = $path, r.updated_at = timestamp()
            ON MATCH SET r.path = $path, r.updated_at = timestamp()
        """,
        "parameters": {"repo": repo_name, "path": os.path.abspath(repo_dir)}
    })

    # 2. Ingest MAP.md entries (Modules & Endpoints)
    map_file = os.path.join(repo_dir, "docs", "MAP.md")
    parsed_map = parse_map_md(map_file, repo_name)
    modules = parsed_map["modules"]
    endpoints = parsed_map["endpoints"]
    print(f"-> Parsed {len(modules)} modules and {len(endpoints)} endpoints from docs/MAP.md")

    for mod in modules:
        statements.append({
            "statement": """
                MERGE (m:Module {path: $path, repo: $repo})
                ON CREATE SET m.name = $name, m.description = $desc, m.updated_at = timestamp()
                ON MATCH SET m.name = $name, m.description = $desc, m.updated_at = timestamp()
                WITH m
                MATCH (r:Repository {name: $repo})
                MERGE (r)-[:CONTAINS]->(m)
            """,
            "parameters": {
                "name": mod["name"],
                "path": mod["path"],
                "desc": mod["description"],
                "repo": repo_name,
            }
        })

    for ep in endpoints:
        statements.append({
            "statement": """
                MERGE (e:Endpoint {method: $method, path: $path, repo: $repo})
                ON CREATE SET e.description = $desc, e.updated_at = timestamp()
                ON MATCH SET e.description = $desc, e.updated_at = timestamp()
                WITH e
                MATCH (r:Repository {name: $repo})
                MERGE (r)-[:EXPOSES]->(e)
            """,
            "parameters": {
                "method": ep["method"],
                "path": ep["path"],
                "desc": ep["description"],
                "repo": repo_name,
            }
        })

    # If macro_only, skip scanning individual source files
    if not macro_only:
        ts_files = []
        py_files = []
        skip_dirs = {"node_modules", "dist", ".git", ".hermes", "venv", ".venv", "__pycache__", "build", ".next"}

        for root, dirs, files in os.walk(repo_dir):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for file in files:
                if file.endswith((".ts", ".tsx")) and not file.endswith(".d.ts"):
                    ts_files.append(os.path.join(root, file))
                elif file.endswith(".py"):
                    py_files.append(os.path.join(root, file))

        print(f"-> Discovered {len(ts_files)} TypeScript and {len(py_files)} Python source files to inspect")
        total_interfaces = 0
        total_classes = 0
        total_types = 0
        total_functions = 0

        # Scan TypeScript
        for ts_path in ts_files:
            symbols = extract_ts_symbols(ts_path, repo_name)
            for iface in symbols.get("interfaces", []):
                total_interfaces += 1
                statements.append({
                    "statement": """
                        MERGE (i:Interface {name: $name, file: $file, repo: $repo})
                        ON CREATE SET i.exported_fields = $fields, i.extends = $extends, i.updated_at = timestamp()
                        ON MATCH SET i.exported_fields = $fields, i.extends = $extends, i.updated_at = timestamp()
                        WITH i
                        MATCH (r:Repository {name: $repo})
                        MERGE (r)-[:DECLARES]->(i)
                    """,
                    "parameters": {
                        "name": iface["name"],
                        "file": iface["file"],
                        "fields": iface["fields"],
                        "extends": iface["extends"],
                        "repo": repo_name,
                    }
                })

            for cls in symbols.get("classes", []):
                total_classes += 1
                statements.append({
                    "statement": """
                        MERGE (c:Class {name: $name, file: $file, repo: $repo})
                        ON CREATE SET c.methods = $methods, c.extends = $extends, c.implements = $implements, c.updated_at = timestamp()
                        ON MATCH SET c.methods = $methods, c.extends = $extends, c.implements = $implements, c.updated_at = timestamp()
                        WITH c
                        MATCH (r:Repository {name: $repo})
                        MERGE (r)-[:DECLARES]->(c)
                    """,
                    "parameters": {
                        "name": cls["name"],
                        "file": cls["file"],
                        "methods": cls["methods"],
                        "extends": cls["extends"],
                        "implements": cls["implements"],
                        "repo": repo_name,
                    }
                })

            for tp in symbols.get("types", []):
                total_types += 1
                statements.append({
                    "statement": """
                        MERGE (t:Type {name: $name, file: $file, repo: $repo})
                        ON CREATE SET t.definition = $defn, t.updated_at = timestamp()
                        ON MATCH SET t.definition = $defn, t.updated_at = timestamp()
                        WITH t
                        MATCH (r:Repository {name: $repo})
                        MERGE (r)-[:DECLARES]->(t)
                    """,
                    "parameters": {
                        "name": tp["name"],
                        "file": tp["file"],
                        "defn": tp["definition"],
                        "repo": repo_name,
                    }
                })

            for fn in symbols.get("functions", []):
                total_functions += 1
                statements.append({
                    "statement": """
                        MERGE (f:Function {name: $name, file: $file, repo: $repo})
                        ON CREATE SET f.signature = $sig, f.updated_at = timestamp()
                        ON MATCH SET f.signature = $sig, f.updated_at = timestamp()
                        WITH f
                        MATCH (r:Repository {name: $repo})
                        MERGE (r)-[:DECLARES]->(f)
                    """,
                    "parameters": {
                        "name": fn["name"],
                        "file": fn["file"],
                        "sig": fn["signature"],
                        "repo": repo_name,
                    }
                })

        # Scan Python
        for py_path in py_files:
            py_symbols = extract_py_symbols(py_path, repo_name)
            for cls in py_symbols.get("classes", []):
                total_classes += 1
                statements.append({
                    "statement": """
                        MERGE (c:Class {name: $name, file: $file, repo: $repo})
                        ON CREATE SET c.methods = $methods, c.extends = $extends, c.description = $desc, c.updated_at = timestamp()
                        ON MATCH SET c.methods = $methods, c.extends = $extends, c.description = $desc, c.updated_at = timestamp()
                        WITH c
                        MATCH (r:Repository {name: $repo})
                        MERGE (r)-[:DECLARES]->(c)
                    """,
                    "parameters": {
                        "name": cls["name"],
                        "file": cls["file"],
                        "methods": cls["methods"],
                        "extends": cls["extends"],
                        "desc": cls["description"],
                        "repo": repo_name,
                    }
                })

            for fn in py_symbols.get("functions", []):
                total_functions += 1
                statements.append({
                    "statement": """
                        MERGE (f:Function {name: $name, file: $file, repo: $repo})
                        ON CREATE SET f.signature = $sig, f.description = $desc, f.updated_at = timestamp()
                        ON MATCH SET f.signature = $sig, f.description = $desc, f.updated_at = timestamp()
                        WITH f
                        MATCH (r:Repository {name: $repo})
                        MERGE (r)-[:DECLARES]->(f)
                    """,
                    "parameters": {
                        "name": fn["name"],
                        "file": fn["file"],
                        "sig": fn["signature"],
                        "desc": fn["description"],
                        "repo": repo_name,
                    }
                })

        print(f"-> Extracted: {total_interfaces} interfaces, {total_classes} classes, {total_types} types, {total_functions} functions.")

    print(f"-> Total Cypher operations queued: {len(statements)}")

    # Execute statements in batches of 50
    batch_size = 50
    committed = 0
    for i in range(0, len(statements), batch_size):
        batch = statements[i:i + batch_size]
        success, err = run_cypher(neo4j_url, batch)
        if not success:
            print(f"Error in batch {i // batch_size + 1}: {err}")
            return False
        committed += len(batch)
        if len(statements) > 50:
            print(f"   Committed {committed}/{len(statements)} statements...")

    print(f"✅ Successfully synchronized '{repo_name}' with Neo4j Knowledge Graph!")
    return True


def ingest_all_homelab_repos(repos_dir: str = "/home/jagosan/repos", neo4j_url: str = DEFAULT_NEO4J_URL, macro_only: bool = True) -> Dict[str, bool]:
    """Discover and ingest all repositories containing docs/MAP.md."""
    results = {}
    if not os.path.exists(repos_dir):
        print(f"Repos directory not found: {repos_dir}")
        return results

    for entry in sorted(os.listdir(repos_dir)):
        entry_path = os.path.join(repos_dir, entry)
        if os.path.isdir(entry_path):
            map_p = os.path.join(entry_path, "docs", "MAP.md")
            if os.path.exists(map_p):
                ok = ingest_repository(entry_path, neo4j_url=neo4j_url, macro_only=macro_only)
                results[entry] = ok

    return results


def main():
    parser = argparse.ArgumentParser(description="Ingest repository symbols into Neo4j.")
    parser.add_argument("repo_dir", nargs="?", default=".", help="Target repository directory (default: .)")
    parser.add_argument("--neo4j", default=DEFAULT_NEO4J_URL, help="Neo4j TX HTTP endpoint")
    parser.add_argument("--macro-only", "-m", action="store_true", help="Ingest only macro architecture (MAP.md & endpoints), skipping full AST file scans")
    parser.add_argument("--all", "-a", action="store_true", help="Ingest all repositories under /home/jagosan/repos with docs/MAP.md")
    args = parser.parse_args()

    if args.all:
        results = ingest_all_homelab_repos(neo4j_url=args.neo4j, macro_only=args.macro_only)
        all_ok = all(results.values())
        sys.exit(0 if all_ok else 1)
    else:
        success = ingest_repository(args.repo_dir, neo4j_url=args.neo4j, macro_only=args.macro_only)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
