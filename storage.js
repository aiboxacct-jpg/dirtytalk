// Image upload. Uses Cloudinary when CLOUDINARY_URL is set (production /
// persistent); otherwise writes to ./uploads for local dev.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const useCloudinary = !!process.env.CLOUDINARY_URL;
let cloudinary = null;
if (useCloudinary) cloudinary = require('cloudinary').v2; // reads CLOUDINARY_URL from env

// Accept a single in-memory image, max 10 MB, images only.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

// Upload a buffer, resolve to a deliverable https URL (size-capped, optimized).
function uploadImage(buffer, originalName) {
  if (useCloudinary) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'dirtytalk', resource_type: 'image' },
        (err, result) => {
          if (err) return reject(err);
          resolve(
            cloudinary.url(result.public_id, {
              secure: true,
              fetch_format: 'auto',
              quality: 'auto',
              transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
            })
          );
        }
      );
      stream.end(buffer);
    });
  }
  // Local dev fallback.
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = ((path.extname(originalName || '') || '.jpg').toLowerCase().match(/^\.[a-z0-9]+$/) || ['.jpg'])[0];
  const name = crypto.randomBytes(12).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return Promise.resolve('/uploads/' + name);
}

// multer as middleware that returns JSON (not an HTML error page) on failure.
function uploadSingle(field) {
  const mw = upload.single(field);
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image too large (max 10 MB).' : err.message || 'Upload failed.';
        return res.status(400).json({ ok: false, error: msg });
      }
      next();
    });
}

module.exports = { upload, uploadSingle, uploadImage, UPLOAD_DIR };
