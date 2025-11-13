const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const sanitize = require('sanitize-filename');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - Required for Render deployment
app.set('trust proxy', 1);

// Ensure required directories exist
const SITES_DIR = path.join(__dirname, 'sites');
const DELETED_DIR = path.join(SITES_DIR, '.deleted');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(SITES_DIR)) fs.mkdirSync(SITES_DIR, { recursive: true });
if (!fs.existsSync(DELETED_DIR)) fs.mkdirSync(DELETED_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Initialize SQLite database
const db = new Database(path.join(__dirname, 'data.db'));

// Create sites table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    size_bytes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Increase payload limit for multiple files
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Rate limiting for API routes
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Serve static frontend
app.use(express.static(PUBLIC_DIR));

// Allowed file extensions
const ALLOWED_EXTENSIONS = ['.zip', '.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.ico', '.txt', '.json'];
const FORBIDDEN_EXTENSIONS = ['.php', '.py', '.sh', '.env', '.exe', '.dll', '.bat', '.cmd'];

// Helper: Calculate folder size
function getFolderSize(folderPath) {
  let totalSize = 0;
  
  function calculateSize(dirPath) {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        calculateSize(filePath);
      } else {
        totalSize += stats.size;
      }
    }
  }
  
  if (fs.existsSync(folderPath)) {
    calculateSize(folderPath);
  }
  return totalSize;
}

// Helper: Delete folder recursively
function deleteFolderRecursive(folderPath) {
  if (fs.existsSync(folderPath)) {
    fs.readdirSync(folderPath).forEach((file) => {
      const curPath = path.join(folderPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteFolderRecursive(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(folderPath);
  }
}

// Helper: Move folder
function moveFolder(source, destination) {
  if (!fs.existsSync(source)) return;
  
  if (fs.existsSync(destination)) {
    deleteFolderRecursive(destination);
  }
  
  fs.renameSync(source, destination);
}

// Helper: Validate file extension
function isAllowedExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

function isForbiddenExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return FORBIDDEN_EXTENSIONS.includes(ext);
}

// API: Upload site (supports single file, multiple files, or ZIP)
app.post('/api/upload', (req, res) => {
  try {
    if (!req.body.siteName) {
      return res.status(400).json({ ok: false, error: 'Missing siteName' });
    }

    const siteName = req.body.siteName.trim();
    
    // Sanitize site name to create slug
    const slug = sanitize(siteName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'Invalid site name' });
    }

    // Check if slug already exists
    const existing = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'Site with this name already exists' });
    }

    const siteDir = path.join(SITES_DIR, slug);
    
    // Create site directory
    if (!fs.existsSync(siteDir)) {
      fs.mkdirSync(siteDir, { recursive: true });
    }

    // Support both single file and multiple files
    const files = req.body.files; // Array of {fileName, fileData}
    
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, error: 'No files provided' });
    }

    // Process each file
    for (const fileObj of files) {
      const { fileName, fileData } = fileObj;
      
      if (!fileName || !fileData) {
        deleteFolderRecursive(siteDir);
        return res.status(400).json({ ok: false, error: 'Invalid file data' });
      }

      const ext = path.extname(fileName).toLowerCase();
      const buffer = Buffer.from(fileData, 'base64');

      if (ext === '.zip') {
        // Extract ZIP file - FIXED: overwrite false prevents path issues
        try {
          const zip = new AdmZip(buffer);
          const zipEntries = zip.getEntries();

          // Validate ZIP contents
          for (const entry of zipEntries) {
            if (isForbiddenExtension(entry.entryName)) {
              deleteFolderRecursive(siteDir);
              return res.status(400).json({ ok: false, error: `Forbidden file type detected: ${entry.entryName}` });
            }
          }

          // Extract all files - overwrite set to true
          zip.extractAllTo(siteDir, true);
          
        } catch (zipError) {
          console.error('ZIP extraction error:', zipError);
          deleteFolderRecursive(siteDir);
          return res.status(400).json({ ok: false, error: 'Failed to extract ZIP file' });
        }
      } else if (isAllowedExtension(fileName)) {
        // Save single file
        const sanitizedFileName = sanitize(fileName);
        const filePath = path.join(siteDir, sanitizedFileName);
        fs.writeFileSync(filePath, buffer);
      } else {
        deleteFolderRecursive(siteDir);
        return res.status(400).json({ ok: false, error: `File type not allowed: ${fileName}` });
      }
    }

    // Calculate folder size
    const sizeBytes = getFolderSize(siteDir);

    // Insert into database
    const insert = db.prepare('INSERT INTO sites (name, slug, size_bytes, status) VALUES (?, ?, ?, ?)');
    insert.run(siteName, slug, sizeBytes, 'active');

    const url = `${req.protocol}://${req.get('host')}/view/${slug}`;

    res.json({
      ok: true,
      url,
      slug,
      message: 'Site uploaded successfully'
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// View site handler
function handleSiteView(req, res) {
  const slug = req.params.slug || req.query.site;
  
  if (!slug) {
    return res.status(400).send('Missing site parameter');
  }

  const sanitizedSlug = sanitize(slug);
  const siteDir = path.join(SITES_DIR, sanitizedSlug);

  if (!fs.existsSync(siteDir)) {
    return res.status(404).send('Site not found');
  }

  // Check if site is active
  const site = db.prepare('SELECT * FROM sites WHERE slug = ? AND status = ?').get(sanitizedSlug, 'active');
  if (!site) {
    return res.status(404).send('Site not found or deleted');
  }

  // Serve index.html by default
  const indexPath = path.join(siteDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  // If no index.html, list files
  const files = fs.readdirSync(siteDir);
  if (files.length === 1) {
    return res.sendFile(path.join(siteDir, files[0]));
  }

  res.send(`<h1>Site: ${site.name}</h1><ul>${files.map(f => `<li><a href="/sites/${sanitizedSlug}/${f}">${f}</a></li>`).join('')}</ul>`);
}

// View site routes - both /view.php?site=slug and /view/:slug work
app.get('/view.php', handleSiteView);
app.get('/view/:slug', handleSiteView);

// CRITICAL FIX: Serve each site's static files (CSS, JS, images) with correct MIME types
app.use('/sites/:slug', (req, res, next) => {
  const slug = sanitize(req.params.slug);
  const siteDir = path.join(SITES_DIR, slug);
  
  // Use express.static for each site folder dynamically
  express.static(siteDir)(req, res, next);
});

// Fallback: Serve static site files
app.use('/sites', express.static(SITES_DIR));

// Admin API: Get all sites
app.get('/api/admin/sites', (req, res) => {
  try {
    const sites = db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all();
    res.json({ ok: true, sites });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Delete site
app.post('/api/admin/site/:slug/delete', (req, res) => {
  try {
    const { slug } = req.params;
    const sanitizedSlug = sanitize(slug);

    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(sanitizedSlug);
    if (!site) {
      return res.status(404).json({ ok: false, error: 'Site not found' });
    }

    const sourceDir = path.join(SITES_DIR, sanitizedSlug);
    const destDir = path.join(DELETED_DIR, sanitizedSlug);

    if (fs.existsSync(sourceDir)) {
      moveFolder(sourceDir, destDir);
    }

    db.prepare('UPDATE sites SET status = ? WHERE slug = ?').run('deleted', sanitizedSlug);

    res.json({ ok: true, message: 'Site deleted successfully' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Restore site
app.post('/api/admin/site/:slug/restore', (req, res) => {
  try {
    const { slug } = req.params;
    const sanitizedSlug = sanitize(slug);

    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(sanitizedSlug);
    if (!site) {
      return res.status(404).json({ ok: false, error: 'Site not found' });
    }

    const sourceDir = path.join(DELETED_DIR, sanitizedSlug);
    const destDir = path.join(SITES_DIR, sanitizedSlug);

    if (fs.existsSync(sourceDir)) {
      moveFolder(sourceDir, destDir);
    }

    db.prepare('UPDATE sites SET status = ? WHERE slug = ?').run('active', sanitizedSlug);

    res.json({ ok: true, message: 'Site restored successfully' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Get usage stats
app.get('/api/admin/usage', (req, res) => {
  try {
    const totalSites = db.prepare('SELECT COUNT(*) as count FROM sites WHERE status = ?').get('active').count;
    const totalStorage = db.prepare('SELECT SUM(size_bytes) as total FROM sites WHERE status = ?').get('active').total || 0;

    res.json({
      ok: true,
      totalSites,
      totalStorage,
      totalStorageFormatted: `${(totalStorage / 1024 / 1024).toFixed(2)} MB`
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Download site as ZIP
app.get('/api/admin/site/:slug/download', (req, res) => {
  try {
    const { slug } = req.params;
    const sanitizedSlug = sanitize(slug);

    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(sanitizedSlug);
    if (!site) {
      return res.status(404).json({ ok: false, error: 'Site not found' });
    }

    const siteDir = path.join(SITES_DIR, sanitizedSlug);
    
    if (!fs.existsSync(siteDir)) {
      return res.status(404).json({ ok: false, error: 'Site directory not found' });
    }

    const zip = new AdmZip();
    zip.addLocalFolder(siteDir);
    const zipBuffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedSlug}.zip"`);
    res.send(zipBuffer);

  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Public URL: http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});
