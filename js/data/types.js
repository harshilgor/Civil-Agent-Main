/**
 * @typedef {'pass'|'warn'|'fail'|'unsized'} Status
 *
 * @typedef {object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} location
 * @property {string} codeBasis
 * @property {string} materialSystem
 * @property {string} status
 * @property {string} updatedAt
 * @property {number} stories
 *
 * @typedef {object} Level
 * @property {string} id
 * @property {string} name
 * @property {number} elevation   - feet
 * @property {number} height      - feet
 *
 * @typedef {object} GridLine
 * @property {string} id
 * @property {'x'|'y'} axis
 * @property {string} label
 * @property {number} coordinate
 * @property {boolean} locked
 * @property {string} confidence
 *
 * @typedef {object} Column
 * @property {string} id
 * @property {string} gridLabel
 * @property {number} x
 * @property {number} y
 * @property {string} startLevel
 * @property {string} endLevel
 * @property {string} size
 * @property {number} dcr
 * @property {Status} status
 * @property {boolean} locked
 *
 * @typedef {object} Beam
 * @property {string} id
 * @property {[number, number]} start
 * @property {[number, number]} end
 * @property {string} levelId
 * @property {string} size
 * @property {number} dcr
 * @property {Status} status
 * @property {boolean} locked
 *
 * @typedef {object} ShearWall
 * @property {string} id
 * @property {'N-S'|'E-W'} direction
 * @property {[number, number, number, number]} boundary - [x, y, w, h]
 * @property {number} dcr
 * @property {Status} status
 *
 * @typedef {object} Brace
 * @property {string} id
 * @property {[number, number]} start
 * @property {[number, number]} end
 * @property {Status} status
 *
 * @typedef {object} Scheme
 * @property {string} id
 * @property {string} name
 * @property {string} strategy
 * @property {string} note
 *
 * @typedef {object} Assumption
 * @property {string} id
 * @property {string} category
 * @property {string} label
 * @property {string} value
 * @property {string} units
 * @property {string} status
 *
 * @typedef {object} VaultDocument
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {string} fileType
 * @property {string} aiStatus
 * @property {string} reviewStatus
 *
 * @typedef {object} Issue
 * @property {string} id
 * @property {'Warning'|'Fail'} severity
 * @property {string} objectType
 * @property {string} objectId
 * @property {string} title
 * @property {number} dcr
 *
 * @typedef {object} Report
 * @property {string} id
 * @property {string} name
 * @property {string} status
 */

export const __types = true;
