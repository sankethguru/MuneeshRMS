// fsutil.js
// A single, shared helper used by every module that persists JSON to
// disk (db.js, schema.js, users.js, audit.js). A plain fs.writeFileSync
// straight onto the real target file rewrites it in place — if the
// process crashes or is killed mid-write, the file is left truncated or
// corrupted, and there's no way to recover the data that was in it a
// moment before. Writing to a temp file first, then renaming it over
// the original, avoids this: fs.renameSync is atomic on the same
// filesystem (which this always is, since the temp file is written
// right next to the target), so any given read of the target file
// always sees either the complete old version or the complete new one,
// never a partial write.
const fs = require('fs');
const path = require('path');

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

module.exports = { atomicWriteFileSync };
