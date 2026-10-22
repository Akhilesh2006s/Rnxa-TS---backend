import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { assign, makeProject, makeUser, setPolicy, signIn, superAdmin, yesterdayOrToday } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5b10000000049454e44ae426082", "hex");

describe("attachments", () => {
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let manager: Awaited<ReturnType<typeof makeUser>>;
  let outsider: Awaited<ReturnType<typeof makeUser>>;
  let project: Awaited<ReturnType<typeof makeProject>>;

  beforeAll(async () => {
    await setPolicy({ autoVerify: false });
    manager = await makeUser("MANAGER", "Att Lead");
    owner = await makeUser("EMPLOYEE", "Att Owner", manager.id);
    outsider = await makeUser("EMPLOYEE", "Att Outsider");
    project = await makeProject(["Build"]);
    await assign(owner.id, project.id);
  });

  async function newEntry() {
    const api = await signIn(owner.email);
    const res = await api.post("/api/entries").send({ workDate: yesterdayOrToday(), projectId: project.id, phaseId: project.phases[0].id, minutes: 60, description: "Site visit" });
    expect(res.status).toBe(201);
    return { api, entry: res.body.entry };
  }

  const upload = (api: Awaited<ReturnType<typeof signIn>>, entryId: string, name: string, body: Buffer) =>
    api.post(`/api/entries/${entryId}/attachments`).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name)).send(body);

  it("lets the owner attach a photo, shows it on the entry, and serves it to the verifier only", async () => {
    const { api, entry } = await newEntry();
    const res = await upload(api, entry.id, "../site photo.PNG", PNG);
    expect(res.status).toBe(201);
    expect(res.body.attachment).toMatchObject({ fileName: "site photo.PNG", kind: "IMAGE", mimeType: "image/png", size: PNG.length });
    expect(res.body.attachment.storageKey).toBeUndefined();

    const list = await api.get(`/api/entries?from=${entry.workDate}&to=${entry.workDate}`);
    expect(list.body.entries.find((e: { id: string }) => e.id === entry.id).attachments).toHaveLength(1);

    const id = res.body.attachment.id;
    const mine = await api.get(`/api/attachments/${id}`).buffer(true);
    expect(mine.status).toBe(200);
    expect(mine.headers["content-type"]).toBe("image/png");
    expect(mine.headers["x-content-type-options"]).toBe("nosniff");
    expect(mine.headers["content-security-policy"]).toContain("sandbox");

    expect((await (await signIn(manager.email)).get(`/api/attachments/${id}`)).status).toBe(200);
    expect((await (await signIn((await superAdmin()).email)).get(`/api/attachments/${id}`)).status).toBe(200);
    expect((await (await signIn(outsider.email)).get(`/api/attachments/${id}`)).status).toBe(404);
    // Only the owner removes files.
    expect((await (await signIn(manager.email)).delete(`/api/attachments/${id}`)).status).toBe(404);
  });

  it("rejects unsupported types, oversize files and uploads by anyone but the owner", async () => {
    const { api, entry } = await newEntry();
    expect((await upload(api, entry.id, "page.html", Buffer.from("<script>alert(1)</script>"))).status).toBe(400);
    expect((await upload(api, entry.id, "logo.svg", Buffer.from("<svg/>"))).status).toBe(400);
    // Over the limit: the server answers 413 and may close the connection before the body is sent.
    const big = await upload(api, entry.id, "big.mp4", Buffer.alloc(1024 * 1024 + 10)).then((r) => r.status, (e: Error) => e.message);
    expect([413, "read ECONNRESET", "write ECONNRESET", "write EPIPE"]).toContain(big);
    expect((await upload(await signIn(outsider.email), entry.id, "x.png", PNG)).status).toBe(404);
    expect(await prisma.attachment.count({ where: { entryId: entry.id } })).toBe(0);
  });

  it("locks files once the entry is verified, and deletes them with a draft", async () => {
    const { api, entry } = await newEntry();
    const att = (await upload(api, entry.id, "report.pdf", Buffer.from("%PDF-1.4 test"))).body.attachment;
    expect(att.kind).toBe("DOCUMENT");
    await api.post(`/api/weeks/${entry.workDate}/submit`).send({});
    // Evidence can still be added while waiting.
    expect((await upload(api, entry.id, "clip.mp4", Buffer.from("fake video"))).status).toBe(201);
    const lead = await signIn(manager.email);
    expect((await lead.post("/api/reviews/actions").send({ ids: [entry.id], action: "APPROVE" })).status).toBe(200);
    expect((await upload(api, entry.id, "late.png", PNG)).status).toBe(409);
    expect((await api.delete(`/api/attachments/${att.id}`)).status).toBe(409);

    const draft = await newEntry();
    const a2 = (await upload(draft.api, draft.entry.id, "a.png", PNG)).body.attachment;
    expect((await draft.api.delete(`/api/entries/${draft.entry.id}`)).status).toBe(200);
    expect(await prisma.attachment.findUnique({ where: { id: a2.id } })).toBeNull();
  });
});
