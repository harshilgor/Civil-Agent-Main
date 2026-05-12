/**
 * Three-step file upload flow that the FastAPI service expects:
 *
 *   1. POST /api/projects/{p}/files/upload-url        → presigned PUT URL + fileId
 *   2. PUT  <presignedUrl>                             → bytes go straight to S3
 *   3. POST /api/projects/{p}/files/{f}/registered     → record size + sha256
 *
 * The `sha256` is required by the parser (it powers the idempotency key
 * used to dedupe parse jobs), so we always compute it before step 3.
 *
 * `uploadFile` is intentionally chatty about progress via the `onStage`
 * callback so the UI can render meaningful "uploading… registering…"
 * states for each file individually.
 */

import { request, sha256Hex } from "./client.js";

const CONTENT_TYPE_BY_EXT = {
  ifc: "application/x-step",
  dxf: "application/dxf",
  dwg: "application/acad",
  pdf: "application/pdf",
};

/** Pick the content-type the server allow-list accepts for a given filename. */
export function contentTypeFor(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream";
}

/**
 * Run the full presign → PUT → register sequence for one file.
 *
 * @param {string} projectId
 * @param {File}   file - browser File (from <input type="file"> or drop)
 * @param {object} [opts]
 * @param {(stage: string) => void} [opts.onStage] - called with
 *   "presign" | "upload" | "register" | "done" as the flow advances
 * @returns {Promise<{ fileId: string, sha256: string|null, contentType: string }>}
 */
export async function uploadFile(projectId, file, { onStage } = {}) {
  const contentType = contentTypeFor(file.name);

  onStage?.("presign");
  const presign = await request(
    `/api/projects/${projectId}/files/upload-url`,
    {
      method: "POST",
      body: { filename: file.name, contentType },
    },
  );

  onStage?.("upload");
  const putRes = await fetch(presign.presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`S3 upload failed (${putRes.status} ${putRes.statusText})`);
  }

  onStage?.("register");
  const sha256 = await sha256Hex(file);
  await request(
    `/api/projects/${projectId}/files/${presign.fileId}/registered`,
    {
      method: "POST",
      body: {
        fileId: presign.fileId,
        fileSize: file.size,
        sha256,
      },
    },
  );

  onStage?.("done");
  return { fileId: presign.fileId, sha256, contentType };
}
