import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Get current chain height
  const resp = await fetch("https://api.shelbynet.shelby.xyz/v1");
  const info = await resp.json() as { block_height: string };
  const currentHeight = Number(info.block_height);

  // Start 50 blocks before tip to catch recent activity
  const startBlock = currentHeight - 50;

  const result = await prisma.crawlerState.upsert({
    where: { key: "last_processed_block" },
    update: { value: String(startBlock) },
    create: { key: "last_processed_block", value: String(startBlock) },
  });

  console.log(`✅ Crawler state seeded: block ${result.value} (tip is ${currentHeight})`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
