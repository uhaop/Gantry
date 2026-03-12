import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

type Rule = {
  name: string;
  pattern: RegExp;
};

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const rules: Rule[] = [
  { name: "telegram-bot-token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { name: "github-personal-token", pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: "private-key-block", pattern: /-----BEGIN (RSA|EC|OPENSSH|DSA|PRIVATE) KEY-----/g },
  { name: "windows-user-path", pattern: /C:\\Users\\[A-Za-z0-9._-]+\\/g },
  { name: "mac-user-path", pattern: /\/Users\/[A-Za-z0-9._-]+\//g }
];

function getTrackedFiles(): string[] {
  const output = execSync("git ls-files", { encoding: "utf8" });
  return output
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function scanFile(path: string): Array<{ path: string; line: number; rule: string; value: string }> {
  const findings: Array<{ path: string; line: number; rule: string; value: string }> = [];
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return findings;
  }
  if (size > MAX_FILE_BYTES) return findings;

  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return findings;
  }

  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null = re.exec(text);
    while (match) {
      findings.push({
        path,
        line: lineNumberAt(text, match.index),
        rule: rule.name,
        value: match[0]
      });
      match = re.exec(text);
    }
  }
  return findings;
}

function main(): void {
  const files = getTrackedFiles();
  const findings = files.flatMap((file) => scanFile(file));
  if (findings.length === 0) {
    console.log("secret-scan: no high-risk findings in tracked files");
    process.exit(0);
  }

  console.error("secret-scan: potential sensitive data found in tracked files:");
  for (const item of findings) {
    console.error(`- ${item.path}:${item.line} [${item.rule}] ${item.value}`);
  }
  process.exit(1);
}

main();
