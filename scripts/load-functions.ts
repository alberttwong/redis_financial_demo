import { loadFinancialTransactionFunctions } from "../src/lib/function-loader";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";

async function main() {
  const client = await getRedisClient();
  const library = await loadFinancialTransactionFunctions(client);
  console.log(`Redis Function library loaded: ${library}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedisClient();
  });
