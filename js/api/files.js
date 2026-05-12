/**
 * File-level API helpers (separate from upload.js which handles
 * the presign → PUT → register write path).
 */

import { request } from "./client.js";

/**
 * Fetch a presigned S3 download URL for one project file.
 * (Legacy — prefer getGeometrySourceFileUrl when the geometry ID is known.)
 *
 * @param {string} projectId
 * @param {string} fileId
 * @returns {Promise<{ fileId, downloadUrl, expiresInSeconds, filename, fileFormat }>}
 */
export async function getFileDownloadUrl(projectId, fileId) {
  return request(`/api/projects/${projectId}/files/${fileId}/download-url`);
}

/**
 * Fetch a presigned S3 download URL for the original source IFC file
 * that was parsed into a specific geometry version.
 *
 * This is more robust than `getFileDownloadUrl` because:
 *   1. It follows the DB's authoritative `source_file_id` FK rather
 *      than the JSON metadata's `sourceFileId` (which can be stale after
 *      a file deletion or DB migration).
 *   2. It automatically falls back to the most recently uploaded IFC for
 *      the project when the original file row no longer exists.
 *
 * @param {string} projectId
 * @param {string} geometryId
 * @returns {Promise<{ fileId, downloadUrl, expiresInSeconds, filename, fileFormat }>}
 */
export async function getGeometrySourceFileUrl(projectId, geometryId) {
  return request(`/api/projects/${projectId}/geometry/${geometryId}/source-file-url`);
}
