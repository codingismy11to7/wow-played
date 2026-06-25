import Database from "better-sqlite3";
import { readFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";

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

// Extract a top-level WoW SavedVariables table (`Name = { ... }`) as raw text,
// stopping at the next top-level declaration. Robust to indentation since only
// top-level vars are bare-word `Name = {` (nested keys are always `["..."]`).
function sliceTopLevelTable(content: string, varName: string): string {
  const start = content.indexOf(`${varName} = {`);
  if (start === -1) return "";
  const rest = content.slice(start);
  const nextRel = rest.slice(1).search(/\n[A-Za-z_]\w* = \{/);
  return nextRel === -1 ? rest : rest.slice(0, nextRel + 1);
}

// AccountPlayed stores realm slugs ("Area52") while DataStore stores display
// names ("Area 52"), so normalize away spaces/punctuation/case before joining.
function levelKey(server: string, name: string): string {
  const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return `${norm(server)} ${norm(name)}`;
}

// WoW doesn't persist character-select levels in a readable cache, but the
// Altoholic/DataStore_Characters addon scrapes UnitLevel() on each login and
// stores it bit-packed in a `BaseInfo` integer (bits 0-6 = level). We join its
// canonical index map (DataStore_CharacterIDs.Set) with the positional
// DataStore_Characters_Info array to recover level per (server, name).
// Returns an empty map if the addon isn't installed (graceful — level stays null).
function parseLevels(savedVarsDir: string): Map<string, number> {
  const levels = new Map<string, number>();

  let coreContent: string;
  let infoContent: string;
  try {
    coreContent = readFileSync(join(savedVarsDir, "DataStore.lua"), "utf-8");
    infoContent = readFileSync(
      join(savedVarsDir, "DataStore_Characters.lua"),
      "utf-8"
    );
  } catch {
    return levels; // DataStore/Altoholic not present
  }

  // DataStore index -> { server, name }, scoped to the character table only
  // (not DataStore_GuildIDs, which shares the same key format).
  const idsBlock = sliceTopLevelTable(coreContent, "DataStore_CharacterIDs");
  const byIndex = new Map<number, { server: string; name: string }>();
  const keyRegex = /\["Default\.([^."]+)\.([^"]*)"\]\s*=\s*(\d+)/g;
  let km;
  while ((km = keyRegex.exec(idsBlock)) !== null) {
    byIndex.set(parseInt(km[3], 10), { server: km[1], name: km[2] });
  }

  // DataStore_Characters_Info is a positional array; entry N corresponds to
  // DataStore index N. Each entry is a flat table containing BaseInfo.
  const infoBlock = sliceTopLevelTable(infoContent, "DataStore_Characters_Info");
  const entryRegex = /\{([^{}]*)\}/g;
  let idx = 0;
  let em;
  while ((em = entryRegex.exec(infoBlock)) !== null) {
    idx += 1;
    const ref = byIndex.get(idx);
    if (!ref) continue;
    const biMatch = /\["BaseInfo"\]\s*=\s*(\d+)/.exec(em[1]);
    if (!biMatch) continue;
    const level = parseInt(biMatch[1], 10) & 0x7f; // bits 0-6 = level
    if (level > 0) levels.set(levelKey(ref.server, ref.name), level);
  }

  return levels;
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
      time_played INTEGER NOT NULL,
      level INTEGER
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
    "INSERT INTO characters (account, server, name, class, time_played, level) VALUES (?, ?, ?, ?, ?, ?)"
  );

  let totalChars = 0;
  for (const { account, luaPath } of accounts) {
    console.log(`Importing account: ${account}`);
    const content = readFileSync(luaPath, "utf-8");
    const chars = parseLua(content);
    const levels = parseLevels(dirname(luaPath));

    let withLevel = 0;
    const insertMany = db.transaction((chars: Omit<Character, "account">[]) => {
      for (const c of chars) {
        const level = levels.get(levelKey(c.server, c.name)) ?? null;
        if (level !== null) withLevel += 1;
        insert.run(account, c.server, c.name, c.class, c.timePlayed, level);
      }
    });
    insertMany(chars);

    db.prepare(
      "INSERT INTO imports (source_path, imported_at, character_count) VALUES (?, ?, ?)"
    ).run(luaPath, new Date().toISOString(), chars.length);

    totalChars += chars.length;
    const levelNote = levels.size === 0
      ? " (no DataStore/Altoholic level data)"
      : ` (${withLevel} with level)`;
    console.log(`  ${chars.length} characters${levelNote}`);
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
