import { mkdir, writeFile } from "node:fs/promises";
import { getSeedConfig } from "../src/lib/config";
import { accountKey, snapshotKey } from "../src/lib/keys";

async function main() {
  const config = getSeedConfig();
  await mkdir("monitor-input", { recursive: true });

  const accountLines = Array.from({ length: Math.min(config.accountCount, 1000) }, (_, index) => {
    const accountId = `A${String(index + 1).padStart(8, "0")}`;
    return `"JSON.GET" "${accountKey(accountId)}" "$"`;
  });

  const snapshotLines = Array.from({ length: Math.min(config.accountCount, 1000) }, (_, index) => {
    const accountId = `A${String(index + 1).padStart(8, "0")}`;
    return `"JSON.GET" "${snapshotKey(accountId)}" "$"`;
  });

  const mixedLines = [
    ...accountLines.slice(0, 400),
    ...snapshotLines.slice(0, 300),
    ...Array.from({ length: 300 }, (_, index) => {
      const accountId = `A${String((index % config.accountCount) + 1).padStart(8, "0")}`;
      return `"FT.SEARCH" "idx:transactions" "@account_id:{${accountId}}" "NOCONTENT" "LIMIT" "0" "20" "DIALECT" "2"`;
    })
  ];

  await writeFile("monitor-input/account-reads.txt", accountLines.join("\n") + "\n");
  await writeFile("monitor-input/snapshot-reads.txt", snapshotLines.join("\n") + "\n");
  await writeFile("monitor-input/mixed.txt", mixedLines.join("\n") + "\n");

  console.log("Wrote monitor-input/account-reads.txt");
  console.log("Wrote monitor-input/snapshot-reads.txt");
  console.log("Wrote monitor-input/mixed.txt");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
