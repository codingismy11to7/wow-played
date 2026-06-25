import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import Database from "better-sqlite3"
import { createServer } from "node:http"
import { join } from "node:path"

const PROJECT_ROOT = join(import.meta.dirname, "..")
const DB_PATH = join(PROJECT_ROOT, "data", "played.db")
const PUBLIC_DIR = join(import.meta.dirname, "public")
const PORT = parseInt(process.env.PORT || "3000", 10)

const Character = Schema.Struct({
  id: Schema.Number,
  account: Schema.String,
  server: Schema.String,
  name: Schema.String,
  class: Schema.String,
  time_played: Schema.Number,
  level: Schema.NullOr(Schema.Number),
})

const Import = Schema.Struct({
  id: Schema.Number,
  source_path: Schema.String,
  imported_at: Schema.String,
  character_count: Schema.Number,
})

const db = new Database(DB_PATH, { readonly: true })

const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    HttpServerResponse.file(join(PUBLIC_DIR, "index.html")),
  ),
  HttpRouter.get(
    "/api/characters",
    Effect.gen(function* () {
      const rows = db.prepare("SELECT * FROM characters ORDER BY time_played DESC").all()
      const characters = Schema.decodeUnknownSync(Schema.Array(Character))(rows)
      return yield* HttpServerResponse.json(characters)
    }),
  ),
  HttpRouter.get(
    "/api/imports",
    Effect.gen(function* () {
      const rows = db.prepare("SELECT * FROM imports ORDER BY imported_at DESC").all()
      const imports = Schema.decodeUnknownSync(Schema.Array(Import))(rows)
      return yield* HttpServerResponse.json(imports)
    }),
  ),
)

const app = router.pipe(
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress,
)

const ServerLive = NodeHttpServer.layer(createServer, { port: PORT })

Layer.launch(Layer.provide(app, ServerLive)).pipe(NodeRuntime.runMain)
