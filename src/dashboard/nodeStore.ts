import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type MultiTraderNode = {
  id: string;
  baseUrl: string;
  customName?: string;
  addedAt: string;
};

const DATA_DIR = path.resolve(process.cwd(), ".voltagent");
const STORE_PATH = path.join(DATA_DIR, "multi-trader-nodes.json");

async function ensureStoreFile() {
	try {
		await fs.mkdir(DATA_DIR, { recursive: true });
		await fs.access(STORE_PATH);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err?.code === "ENOENT") {
			await fs.writeFile(STORE_PATH, "[]", "utf8");
			return;
		}
		throw error;
	}
}

function normalizeBaseUrl(rawUrl: string) {
  let sanitized = rawUrl.trim();
  if (!sanitized) {
    throw new Error("节点地址不能为空");
  }
  if (!/^https?:\/\//i.test(sanitized)) {
    sanitized = `http://${sanitized}`;
  }
  sanitized = sanitized.replace(/\/$/, "");
  return sanitized;
}

export async function getStoredNodes(): Promise<MultiTraderNode[]> {
  await ensureStoreFile();
  const content = await fs.readFile(STORE_PATH, "utf8");
  try {
    const parsed = JSON.parse(content) as MultiTraderNode[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveNodes(nodes: MultiTraderNode[]) {
  await fs.writeFile(STORE_PATH, JSON.stringify(nodes, null, 2), "utf8");
}

export async function addNode(rawUrl: string, customName?: string) {
  const baseUrl = normalizeBaseUrl(rawUrl);
  const nodes = await getStoredNodes();
  if (nodes.some((node) => node.baseUrl === baseUrl)) {
    throw new Error("该节点已存在");
  }
  const node: MultiTraderNode = {
    id: randomUUID(),
    baseUrl,
    customName: customName?.trim() || undefined,
    addedAt: new Date().toISOString(),
  };
  nodes.push(node);
  await saveNodes(nodes);
  return node;
}

export async function removeNode(id: string) {
  const nodes = await getStoredNodes();
  const filtered = nodes.filter((node) => node.id !== id);
  await saveNodes(filtered);
  return nodes.length !== filtered.length;
}

export async function setNodes(nodes: MultiTraderNode[]) {
  await saveNodes(nodes);
}

export function cleanBaseUrl(rawUrl: string) {
  return normalizeBaseUrl(rawUrl);
}

export async function reorderNodes(ids: string[]) {
  const nodes = await getStoredNodes();
  if (ids.length !== nodes.length) {
    throw new Error("排序数据不完整");
  }
  const map = new Map(nodes.map((node) => [node.id, node]));
  const reordered: MultiTraderNode[] = [];
  for (const id of ids) {
    const found = map.get(id);
    if (!found) {
      throw new Error("存在未知的节点 ID");
    }
    reordered.push(found);
  }
  await saveNodes(reordered);
  return reordered;
}
