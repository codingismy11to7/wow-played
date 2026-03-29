import Database from "better-sqlite3";
import { readFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(PROJECT_ROOT, "data", "played.db");

const DEFAULT_WOW_PATH = join(
  process.env.HOME!,
  "Games",
  "World of Warcraft",
  "_retail_"
);

interface Character {
  account: string;
  server: string;
  name: string;
  class: string;
  timePlayed: number;
}

function parseLua(content: string): Omit<Character, "account">[] {
  const results: Omit<Character, "account">[] = [];
  const entryRegex = /\["([^"]+)"\]\s*=\s*\{([^}]+)\}/g;
  const timeRegex = /\["time"\]\s*=\s*(\d+)/;
  const classRegex = /\["class"\]\s*=\s*"([^"]+)"/;

  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const key = match[1];
    const body = match[2];
    const timeMatch = timeRegex.exec(body);
    const classMatch = classRegex.exec(body);
    if (!timeMatch || !classMatch) continue;

    const dashIdx = key.indexOf("-");
    if (dashIdx === -1) continue;

    results.push({
      server: key.slice(0, dashIdx),
      name: key.slice(dashIdx + 1),
      class: classMatch[1],
      timePlayed: parseInt(timeMatch[1], 10),
    });
  }
  return results;
}

function findAccounts(wowPath: string): { account: string; luaPath: string }[] {
  const accountDir = join(wowPath, "WTF", "Account");
  const entries = readdirSync(accountDir, { withFileTypes: true });
  const found: { account: string; luaPath: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const luaPath = join(
      accountDir,
      entry.name,
      "SavedVariables",
      "AccountPlayed.lua"
    );
    try {
      readFileSync(luaPath);
      found.push({ account: entry.name, luaPath });
    } catch {
      // no AccountPlayed data for this account
    }
  }
  return found;
}

function main() {
  const wowPath = process.argv[2] || DEFAULT_WOW_PATH;
  console.log(`WoW path: ${wowPath}`);

  const accounts = findAccounts(wowPath);
  if (accounts.length === 0) {
    console.error("No AccountPlayed.lua files found. Is the path correct?");
    process.exit(1);
  }

  mkdirSync(join(PROJECT_ROOT, "data"), { recursive: true });
  const db = new Database(DB_PATH);

  db.exec(`
    DROP TABLE IF EXISTS characters;
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      server TEXT NOT NULL,
      name TEXT NOT NULL,
      class TEXT NOT NULL,
      time_played INTEGER NOT NULL
    );

    DROP TABLE IF EXISTS imports;
    CREATE TABLE imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      character_count INTEGER NOT NULL
    );
  `);

  const insert = db.prepare(
    "INSERT INTO characters (account, server, name, class, time_played) VALUES (?, ?, ?, ?, ?)"
  );

  let totalChars = 0;
  for (const { account, luaPath } of accounts) {
    console.log(`Importing account: ${account}`);
    const content = readFileSync(luaPath, "utf-8");
    const chars = parseLua(content);

    const insertMany = db.transaction((chars: Omit<Character, "account">[]) => {
      for (const c of chars) {
        insert.run(account, c.server, c.name, c.class, c.timePlayed);
      }
    });
    insertMany(chars);

    db.prepare(
      "INSERT INTO imports (source_path, imported_at, character_count) VALUES (?, ?, ?)"
    ).run(luaPath, new Date().toISOString(), chars.length);

    totalChars += chars.length;
    console.log(`  ${chars.length} characters`);
  }

  const totalTime = db
    .prepare("SELECT SUM(time_played) as total FROM characters")
    .get() as { total: number };

  const days = Math.floor(totalTime.total / 86400);
  const hours = Math.floor((totalTime.total % 86400) / 3600);

  console.log(
    `\nDone: ${totalChars} characters across ${accounts.length} account(s), ${days}d ${hours}h total`
  );
  console.log(`Database: ${DB_PATH}`);

  db.close();
}

main();
