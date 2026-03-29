import Database from "better-sqlite3";
import express from "express";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(PROJECT_ROOT, "data", "played.db");
const PUBLIC_DIR = join(import.meta.dirname, "public");
const PORT = parseInt(process.env.PORT || "3000", 10);

const db = new Database(DB_PATH, { readonly: true });
const app = express();

app.use(express.static(PUBLIC_DIR));

app.get("/api/characters", (_req, res) => {
  const rows = db.prepare("SELECT * FROM characters ORDER BY time_played DESC").all();
  res.json(rows);
});

app.get("/api/imports", (_req, res) => {
  const rows = db.prepare("SELECT * FROM imports ORDER BY imported_at DESC").all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
