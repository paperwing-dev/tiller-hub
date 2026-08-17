import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { checkForUpdate } from "./check-release";

const updateRoutes = new Hono<HonoEnv>();

updateRoutes.get("/api/update/check", async (c) => c.json(await checkForUpdate(c.env, {
  forceRefresh: c.req.query("refresh") === "1",
})));

export default updateRoutes;
