/**
 * Patch @coral-xyz/anchor + @meteora-ag/dlmm for Node ESM compatibility.
 *
 * Meteora DLMM's published ESM bundle imports Anchor utility directories like
 * "@coral-xyz/anchor/dist/cjs/utils/bytes". Node's ESM resolver does not
 * extension-guess directory imports, so native Meteora mode can fail before the
 * first runtime call. This mirrors the compatibility patch used in the legacy
 * Meridian repo.
 */
/* global console */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const anchorPkgPath = path.join(
  root,
  "node_modules/@coral-xyz/anchor/package.json",
);
const anchorUtilsPath = path.join(
  root,
  "node_modules/@coral-xyz/anchor/dist/cjs/utils",
);
const dlmmMjsPath = path.join(
  root,
  "node_modules/@meteora-ag/dlmm/dist/index.mjs",
);

function patchAnchorExports() {
  if (!fs.existsSync(anchorPkgPath) || !fs.existsSync(anchorUtilsPath)) {
    console.log("Skip: @coral-xyz/anchor package not installed");
    return;
  }

  const anchorPkg = JSON.parse(fs.readFileSync(anchorPkgPath, "utf8"));
  if (anchorPkg.exports !== undefined) {
    console.log("Skip: @coral-xyz/anchor exports already set");
    return;
  }

  const utilityDirs = fs
    .readdirSync(anchorUtilsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  anchorPkg.exports = {
    ".": {
      default: "./dist/cjs/index.js",
    },
    ...Object.fromEntries(
      utilityDirs.map((dir) => [
        `./dist/cjs/utils/${dir}`,
        `./dist/cjs/utils/${dir}/index.js`,
      ]),
    ),
    "./*": "./*",
  };

  fs.writeFileSync(anchorPkgPath, JSON.stringify(anchorPkg, null, 2));
  console.log("Patched: @coral-xyz/anchor/package.json exports");
}

function removeBnFromSpecifiers(specifiers) {
  return specifiers
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0)
    .filter((specifier) => !/^BN(\s+as\s+\w+)?$/.test(specifier))
    .join(", ");
}

function patchDlmmEsmBundle() {
  if (!fs.existsSync(dlmmMjsPath)) {
    console.log("Skip: @meteora-ag/dlmm ESM bundle not installed");
    return;
  }

  let source = fs.readFileSync(dlmmMjsPath, "utf8");
  const original = source;

  source = source.replace(
    /from ["'](@coral-xyz\/anchor\/dist\/cjs\/utils\/\w+)["']/g,
    (_, importPath) => `from "${importPath}/index.js"`,
  );

  source = source.replace(/^import BN from ["']bn\.js["'];\n/gm, "");
  source = source.replace(/^var BN = require\(["']bn\.js["']\);\n/gm, "");
  source = source.replace(/^const BN = require\(["']bn\.js["']\);\n/gm, "");

  if (source.includes("BN")) {
    source = `import BN from "bn.js";\n${source}`;
  }

  source = source.replace(
    /import \{([^}]*)\bBN as (\w+)\b([^}]*)\} from "@coral-xyz\/anchor";/g,
    (_, before, alias, after) => {
      const remaining = removeBnFromSpecifiers(`${before},${after}`);
      const anchorImport =
        remaining.length > 0
          ? `import { ${remaining} } from "@coral-xyz/anchor";`
          : "";
      return `${anchorImport}\nconst ${alias} = BN;`;
    },
  );

  source = source.replace(
    /import \{([^}]*)\bBN\b(?!\s*as\b)([^}]*)\} from "@coral-xyz\/anchor";/g,
    (_, before, after) => {
      const remaining = removeBnFromSpecifiers(`${before},${after}`);
      return remaining.length > 0
        ? `import { ${remaining} } from "@coral-xyz/anchor";`
        : "";
    },
  );

  if (source === original) {
    console.log("Skip: @meteora-ag/dlmm ESM bundle already patched");
    return;
  }

  fs.writeFileSync(dlmmMjsPath, source);
  console.log("Patched: @meteora-ag/dlmm/dist/index.mjs");
}

patchAnchorExports();
patchDlmmEsmBundle();
