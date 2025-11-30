const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const sanitize = require('sanitize-filename');
const AdmZip = require('adm-zip');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Track server start time for uptime calculation
const SERVER_START_TIME = Date.now();

// Trust proxy - Required for Render deployment
app.set('trust proxy', 1);

// Ensure required directories exist
const SITES_DIR = path.join(__dirname, 'sites');
const DELETED_DIR = path.join(SITES_DIR, '.deleted');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(SITES_DIR)) fs.mkdirSync(SITES_DIR, { recursive: true });
if (!fs.existsSync(DELETED_DIR)) fs.mkdirSync(DELETED_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Define Mongoose Schema
const siteSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  size_bytes: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'deleted'],
    default: 'active'
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

// Create indexes for better query performance
siteSchema.index({ slug: 1 });
siteSchema.index({ status: 1, created_at: -1 });

const Site = mongoose.model('Site', siteSchema);

// Connect to MongoDB Atlas with error handling
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/file-hosting', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.error('⚠️  Make sure MONGODB_URI is set in .env file');
    process.exit(1);
  }
};

// Handle MongoDB connection events
mongoose.connection.on('disconnected', () => {
  console.log('⚠️  MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB error:', err);
});

// Initialize connection
connectDB();

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

// Serve static frontend (public folder)
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

// Helper: Copy folder recursively
function copyFolderRecursive(source, destination) {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  const files = fs.readdirSync(source);
  for (const file of files) {
    const srcPath = path.join(source, file);
    const destPath = path.join(destination, file);
    
    if (fs.lstatSync(srcPath).isDirectory()) {
      copyFolderRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
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

// Helper: Find index.html recursively in nested folders
function findIndexHtml(directory) {
  const items = fs.readdirSync(directory);
  
  // Check current directory
  if (items.includes('index.html')) {
    return path.join(directory, 'index.html');
  }
  
  // If only one item and it's a directory, check inside
  if (items.length === 1 && fs.lstatSync(path.join(directory, items[0])).isDirectory()) {
    return findIndexHtml(path.join(directory, items[0]));
  }
  
  return null;
}

// Helper: Format uptime
function formatUptime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const uptime = Date.now() - SERVER_START_TIME;
    const totalSites = await Site.countDocuments({ status: 'active' });
    
    const result = await Site.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: null, total: { $sum: '$size_bytes' } } }
    ]);
    
    const totalStorage = result.length > 0 ? result[0].total : 0;

    res.json({
      status: 'ok',
      uptime: formatUptime(uptime),
      uptimeMs: uptime,
      timestamp: new Date().toISOString(),
      server: {
        platform: process.platform,
        nodeVersion: process.version,
        memory: {
          used: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
          total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`
        }
      },
      database: {
        type: 'MongoDB Atlas',
        connected: mongoose.connection.readyState === 1,
        totalSites,
        totalStorage: `${(totalStorage / 1024 / 1024).toFixed(2)} MB`,
        storageBytes: totalStorage
      }
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ 
      status: 'error', 
      error: error.message,
      database: {
        connected: mongoose.connection.readyState === 1
      }
    });
  }
});

// API: Upload site (supports single file, multiple files, or ZIP)
app.post('/api/upload', async (req, res) => {
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
    const existing = await Site.findOne({ slug });
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
        // Extract ZIP file
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

          // Extract all files to temp directory first
          const tempDir = path.join(siteDir, '_temp_extract');
          zip.extractAllTo(tempDir, true);
          
          // Check if extracted to a single subfolder
          const extractedItems = fs.readdirSync(tempDir);
          
          if (extractedItems.length === 1 && fs.lstatSync(path.join(tempDir, extractedItems[0])).isDirectory()) {
            // Move contents of subfolder to main directory
            const subfolderPath = path.join(tempDir, extractedItems[0]);
            copyFolderRecursive(subfolderPath, siteDir);
            deleteFolderRecursive(tempDir);
          } else {
            // Move all items directly
            copyFolderRecursive(tempDir, siteDir);
            deleteFolderRecursive(tempDir);
          }
          
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

    // Insert into MongoDB
    const newSite = new Site({
      name: siteName,
      slug,
      size_bytes: sizeBytes,
      status: 'active'
    });

    await newSite.save();

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

// View site handler - FIXED to handle nested folders
async function handleSiteView(req, res) {
  try {
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
    const site = await Site.findOne({ slug: sanitizedSlug, status: 'active' });
    if (!site) {
      return res.status(404).send('Site not found or deleted');
    }

    // Try to find index.html (even in nested folders)
    const indexPath = findIndexHtml(siteDir);
    
    if (indexPath && fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }

    // If no index.html found, list files
    const files = fs.readdirSync(siteDir);
    
    // If single item and it's a directory, serve its contents
    if (files.length === 1 && fs.lstatSync(path.join(siteDir, files[0])).isDirectory()) {
      return res.redirect(`/sites/${sanitizedSlug}/${files[0]}/`);
    }

    res.send(`
      <h1>Site: ${site.name}</h1>
      <p>Files in this site:</p>
      <ul>
        ${files.map(f => `<li><a href="/sites/${sanitizedSlug}/${f}">${f}</a></li>`).join('')}
      </ul>
    `);
  } catch (error) {
    console.error('View site error:', error);
    res.status(500).send('Internal server error');
  }
}

// Debug route
app.get('/debug/sites', async (req, res) => {
  try {
    const allSites = await Site.find({});
    res.json({ 
      ok: true, 
      totalSites: allSites.length,
      sites: allSites 
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// View site routes
app.get('/view.php', handleSiteView);
app.get('/view/:slug', handleSiteView);

// Admin API: Get all sites
app.get('/api/admin/sites', async (req, res) => {
  try {
    const sites = await Site.find({}).sort({ created_at: -1 });
    res.json({ ok: true, sites });
  } catch (error) {
    console.error('Get sites error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Delete site
app.post('/api/admin/site/:slug/delete', async (req, res) => {
  try {
    const { slug } = req.params;
    const sanitizedSlug = sanitize(slug);

    const site = await Site.findOne({ slug: sanitizedSlug });
    if (!site) {
      return res.status(404).json({ ok: false, error: 'Site not found' });
    }

    const sourceDir = path.join(SITES_DIR, sanitizedSlug);
    const destDir = path.join(DELETED_DIR, sanitizedSlug);

    if (fs.existsSync(sourceDir)) {
      moveFolder(sourceDir, destDir);
    }

    site.status = 'deleted';
    await site.save();

    res.json({ ok: true, message: 'Site deleted successfully' });
  } catch (error) {
    console.error('Delete site error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Restore site
app.post('/api/admin/site/:slug/restore', async (req, res) => {
  try {
    const { slug } = req.params;
    const sanitizedSlug = sanitize(slug);

    const site = await Site.findOne({ slug: sanitizedSlug });
    if (!site) {
      return res.status(404).json({ ok: false, error: 'Site not found' });
    }

    const sourceDir = path.join(DELETED_DIR, sanitizedSlug);
    const destDir = path.join(SITES_DIR, sanitizedSlug);

    if (fs.existsSync(sourceDir)) {
      moveFolder(sourceDir, destDir);
    }

    site.status = 'active';
    await site.save();

    res.json({ ok: true, message: 'Site restored successfully' });
  } catch (error) {
    console.error('Restore site error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Get usage stats
app.get('/api/admin/usage', async (req, res) => {
  try {
    const totalSites = await Site.countDocuments({ status: 'active' });
    
    const result = await Site.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: null, total: { $sum: '$size_bytes' } } }
    ]);
    
    const totalStorage = result.length > 0 ? result[0].total : 0;

    res.json({
      ok: true,
      totalSites,
      totalStorage,
      totalStorageFormatted: `${(totalStorage / 1024 / 1024).toFixed(2)} MB`
    });
  } catch (error) {
    console.error('Usage stats error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin API: Download site as ZIP
app.get('/api/admin/site/:slug/download', async (req, res) => {
  try {
    const { slug } = req.params;
    const sanitizedSlug = sanitize(slug);

    const site = await Site.findOne({ slug: sanitizedSlug });
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
    console.error('Download site error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Serve static files
app.use('/sites', express.static(SITES_DIR));

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Public URL: http://localhost:${PORT}`);
  console.log(`🛠️  Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
});
