import { createIndexes } from "../src/lib/indexes";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";

async function main() {
  const client = await getRedisClient();
  const results = await createIndexes(client);
  for (const result of results) {
    console.log(result);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedisClient();
  });
