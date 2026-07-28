/**
 * Runs every *.test.js in this folder and exits non-zero if any fails.
 *
 *   node tests/run-all.js
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

let failed = 0;
let totalPass = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    encoding: "utf8",
  });
  const output = (result.stdout || "") + (result.stderr || "");
  const passes = (output.match(/^PASS/gm) || []).length;
  const fails = (output.match(/^FAIL/gm) || []).length;
  totalPass += passes;

  if (result.status === 0 && fails === 0) {
    console.log(`  ok    ${file}  (${passes} assertions)`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${file}  (${passes} passed, ${fails} failed)`);
    console.log(
      output
        .split("\n")
        .filter((l) => /^FAIL|expected|got |Error|    at /.test(l))
        .slice(0, 12)
        .map((l) => "        " + l)
        .join("\n")
    );
  }
}

console.log(
  `\n${files.length} file(s), ${totalPass} assertions — ` +
    (failed ? `${failed} FILE(S) FAILED` : "all passed")
);
process.exit(failed ? 1 : 0);
