/**
 * 迁移：为 positions 表添加 system_tp_count、system_trailing_level 字段
 */
import { createClient } from "@libsql/client";

async function ensureColumn(
  client: ReturnType<typeof createClient>,
  columnName: string,
) {
  const info = await client.execute("PRAGMA table_info(positions)");
  const exists = info.rows.some(
    (row: any) => (row.name as string) === columnName,
  );
  if (exists) {
    console.log(`✅ positions.${columnName} 已存在，跳过`);
    return;
  }
  await client.execute(
    `ALTER TABLE positions ADD COLUMN ${columnName} INTEGER DEFAULT 0`,
  );
  console.log(`✅ 已添加 positions.${columnName} 列`);
}

async function migrate() {
  const dbUrl = process.env.DATABASE_URL || "file:./.voltagent/trading.db";
  const client = createClient({ url: dbUrl });
  try {
    await ensureColumn(client, "system_tp_count");
    await ensureColumn(client, "system_trailing_level");
  } catch (error) {
    console.error("迁移失败:", error);
    process.exit(1);
  } finally {
    client.close();
  }
}

migrate();

