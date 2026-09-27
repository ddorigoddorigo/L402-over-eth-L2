#!/usr/bin/env node
/**
 * Standalone compiler based on solc-js.
 *
 * Lets you compile the contracts without Foundry (useful in CI or sandboxes).
 * Produces `artifacts/<Name>.json` with abi + bytecode and `artifacts/index.json`
 * with every artifact together.
 *
 *   npm run compile -w @l402-el2/contracts
 *
 * With Foundry installed you can keep using `forge build` / `forge test`.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const solc = require("solc");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "artifacts");
const NODE_MODULES = resolve(ROOT, "../../node_modules");

/** Recursively lists the .sol files under a directory. */
function listSolidityFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSolidityFiles(full, acc);
    else if (entry.endsWith(".sol")) acc.push(full);
  }
  return acc;
}

/** Resolves imports: `@openzeppelin/...` -> node_modules, anything else -> relative to src. */
function resolveImport(importPath) {
  const candidates = [];
  if (importPath.startsWith("@") || !importPath.startsWith(".")) {
    candidates.push(join(NODE_MODULES, importPath));
  }
  candidates.push(join(SRC, importPath));
  for (const c of candidates) {
    try {
      return { contents: readFileSync(c, "utf8") };
    } catch {
      /* try the next candidate */
    }
  }
  return { error: `File not found: ${importPath}` };
}

const sources = {};
for (const file of listSolidityFiles(SRC)) {
  sources[relative(SRC, file).replaceAll("\\", "/")] = { content: readFileSync(file, "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 1000 },
    evmVersion: "cancun",
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] },
    },
  },
};

const resolvedCache = new Map();
const output = JSON.parse(
  solc.compile(JSON.stringify(input), {
    import: (path) => {
      if (!resolvedCache.has(path)) {
        // Relative imports arrive already normalized against the sources root.
        let r = resolveImport(path);
        if (r.error) r = resolveImport(path.replace(/^\.\.\//, ""));
        resolvedCache.set(path, r);
      }
      return resolvedCache.get(path);
    },
  }),
);

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
const warnings = (output.errors ?? []).filter((e) => e.severity === "warning");
for (const w of warnings) console.warn("⚠️ ", w.formattedMessage?.trim() ?? w.message);
if (errors.length) {
  for (const e of errors) console.error("❌", e.formattedMessage ?? e.message);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const index = {};
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [name, artifact] of Object.entries(contracts)) {
    const record = {
      contractName: name,
      sourceName: file,
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`,
      deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
    };
    writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    index[name] = record;
  }
}
writeFileSync(join(OUT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

const sizes = Object.values(index)
  .map((a) => `${a.contractName}: ${(a.deployedBytecode.length / 2 - 1).toLocaleString()} bytes`)
  .join("\n  ");
console.log(`✅ Compiled ${Object.keys(index).length} contracts with solc ${solc.version()}\n  ${sizes}`);
