const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const sanitize = require('sanitize-filename');
const AdmZip = require('adm-zip');
const { Telegraf } = require('telegraf');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Track server start time for uptime calculation
const SERVER_START_TIME = Date.now();

// Trust proxy - Required for Render deployment
app.set('trust proxy', 1);

// Initialize Telegram Bot (only if credentials provided)
let bot = null;
const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID;

if (process.env.BOT_TOKEN && BACKUP_CHANNEL_ID) {
  bot = new Telegraf(process.env.BOT_TOKEN);
  console.log('📡 Telegram bot initialized');
}

// Ensure required directories exist
const SITES_DIR = path.join(__dirname, 'sites');
const DELETED_DIR = path.join(SITES_DIR, '.deleted');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(SITES_DIR)) fs.mkdirSync(SITES_DIR, { recursive: true });
if (!fs.existsSync(DELETED_DIR)) fs.mkdirSync(DELETED_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Define Mongoose Schema with Telegram backup fields
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
  telegram_file_id: {
    type: String,
    default: null
  },
  telegram_message_id: {
    type: Number,
    default: null
  },
  backup_status: {
    type: String,
    enum: ['none', 'pending', 'completed', 'failed'],
    default: 'none'
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

// Create compound index only (unique: true already creates index on slug)
siteSchema.index({ status: 1, created_at: -1 });

const Site = mongoose.model('Site', siteSchema);

// Connect to MongoDB Atlas with error handling
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/file-hosting');
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

// Telegram Helper: Backup site to Telegram
async function backupToTelegram(slug, siteDir) {
  if (!bot || !BACKUP_CHANNEL_ID) {
    return { success: false, error: 'Telegram not configured' };
  }

  try {
    console.log(`📤 Backing up ${slug} to Telegram...`);
    
    const zip = new AdmZip();
    zip.addLocalFolder(siteDir);
    const zipBuffer = zip.toBuffer();
    
    // Check file size (50MB limit for standard Telegram Bot API)
    const sizeMB = zipBuffer.length / (1024 * 1024);
    if (sizeMB > 50) {
      console.warn(`⚠️  File ${slug} is ${sizeMB.toFixed(2)}MB (exceeds 50MB limit)`);
      return { success: false, error: 'File too large for Telegram backup (max 50MB)' };
    }
    
    // Send to Telegram channel
    const message = await bot.telegram.sendDocument(
      BACKUP_CHANNEL_ID,
      {
        source: zipBuffer,
        filename: `${slug}.zip`
      },
      {
        caption: `🗂️ Backup: ${slug}\n📦 Size: ${sizeMB.toFixed(2)} MB\n📅 Date: ${new Date().toISOString()}\n🔗 Slug: ${slug}`
      }
    );
    
    console.log(`✅ Backed up ${slug} to Telegram (Message ID: ${message.message_id})`);
    
    return {
      success: true,
      file_id: message.document.file_id,
      message_id: message.message_id
    };
  } catch (error) {
    console.error(`❌ Telegram backup error for ${slug}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Telegram Helper: Restore site from Telegram
async function restoreFromTelegram(slug, fileId, targetDir) {
  if (!bot) {
    return { success: false, error: 'Telegram not configured' };
  }

  try {
    console.log(`📥 Restoring ${slug} from Telegram...`);
    
    // Get file info from Telegram
    const file = await bot.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    
    // Download file from Telegram
    const response = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'arraybuffer'
    });
    
    const buffer = Buffer.from(response.data);
    
    // Extract ZIP
    const zip = new AdmZip(buffer);
    
    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    zip.extractAllTo(targetDir, true);
    
    console.log(`✅ Restored ${slug} from Telegram`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Telegram restore error for ${slug}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Restore all sites from Telegram on server start
async function restoreAllSitesFromTelegram() {
  if (!bot || !BACKUP_CHANNEL_ID) {
    console.log('⚠️  Telegram backup disabled (set BOT_TOKEN and BACKUP_CHANNEL_ID in .env)');
    return;
  }

  try {
    const sites = await Site.find({ 
      status: 'active', 
      telegram_file_id: { $ne: null } 
    });
    
    if (sites.length === 0) {
      console.log('📂 No sites to restore from Telegram');
      return;
    }
    
    console.log(`🔄 Restoring ${sites.length} sites from Telegram backup...`);
    
    let restored = 0;
    let skipped = 0;
    let failed = 0;
    
    for (const site of sites) {
      const siteDir = path.join(SITES_DIR, site.slug);
      
      // Skip if directory already exists with files
      if (fs.existsSync(siteDir) && fs.readdirSync(siteDir).length > 0) {
        console.log(`⏭️  Skipping ${site.slug} (already exists)`);
        skipped++;
        continue;
      }
      
      const result = await restoreFromTelegram(site.slug, site.telegram_file_id, siteDir);
      
      if (result.success) {
        restored++;
      } else {
        failed++;
      }
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`✅ Restoration complete: ${restored} restored, ${skipped} skipped, ${failed} failed`);
  } catch (error) {
    console.error('❌ Restore all error:', error);
  }
}

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
    
    // Get backup statistics
    const backedUpSites = await Site.countDocuments({ 
      status: 'active', 
      backup_status: 'completed' 
    });

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
      },
      telegram: {
        enabled: !!bot && !!BACKUP_CHANNEL_ID,
        backedUpSites,
        backupPercentage: totalSites > 0 ? ((backedUpSites / totalSites) * 100).toFixed(1) + '%' : '0%'
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

// API: Upload site (supports single file, multiple files, or ZIP) with Telegram backup
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

    // Backup to Telegram (if configured)
    let backupResult = { success: false, error: 'Telegram not configured' };
    if (bot && BACKUP_CHANNEL_ID) {
      backupResult = await backupToTelegram(slug, siteDir);
    }

    // Insert into MongoDB
    const newSite = new Site({
      name: siteName,
      slug,
      size_bytes: sizeBytes,
      status: 'active',
      telegram_file_id: backupResult.file_id || null,
      telegram_message_id: backupResult.message_id || null,
      backup_status: backupResult.success ? 'completed' : (bot && BACKUP_CHANNEL_ID ? 'failed' : 'none')
    });

    await newSite.save();

    const url = `${req.protocol}://${req.get('host')}/view/${slug}`;

    res.json({
      ok: true,
      url,
      slug,
      message: 'Site uploaded successfully',
      backup: backupResult.success ? 'completed' : (bot && BACKUP_CHANNEL_ID ? 'failed' : 'disabled')
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// View site handler - FIXED to handle nested folders and auto-restore from Telegram
async function handleSiteView(req, res) {
  try {
    const slug = req.params.slug || req.query.site;
    
    if (!slug) {
      return res.status(400).send('Missing site parameter');
    }

    const sanitizedSlug = sanitize(slug);
    const siteDir = path.join(SITES_DIR, sanitizedSlug);

    // Check if site is active
    const site = await Site.findOne({ slug: sanitizedSlug, status: 'active' });
    if (!site) {
      return res.status(404).send('Site not found or deleted');
    }

    // If directory doesn't exist but we have Telegram backup, restore it
    if (!fs.existsSync(siteDir) && site.telegram_file_id && bot) {
      console.log(`🔄 Directory missing for ${sanitizedSlug}, restoring from Telegram...`);
      await restoreFromTelegram(sanitizedSlug, site.telegram_file_id, siteDir);
    }

    if (!fs.existsSync(siteDir)) {
      return res.status(404).send('Site files not found and backup unavailable');
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

    const backupNote = site.telegram_file_id ? ' (backup preserved in Telegram)' : '';
    res.json({ ok: true, message: `Site deleted successfully${backupNote}` });
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

    // Try to restore from deleted folder first
    if (fs.existsSync(sourceDir)) {
      moveFolder(sourceDir, destDir);
    } else if (site.telegram_file_id && bot) {
      // If not in deleted folder, restore from Telegram
      const result = await restoreFromTelegram(sanitizedSlug, site.telegram_file_id, destDir);
      if (!result.success) {
        return res.status(500).json({ ok: false, error: 'Failed to restore from Telegram backup' });
      }
    } else {
      return res.status(404).json({ ok: false, error: 'Site files not found and no backup available' });
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

// API Documentation endpoint - serves static docs.html
app.get('/docs', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'docs.html'));
});

// Serve static files
app.use('/sites', express.static(SITES_DIR));

// Start server
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Public URL: http://localhost:${PORT}`);
  console.log(`🛠️  Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`📚 API Docs: http://localhost:${PORT}/docs`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  
  // Restore sites from Telegram on startup
  if (bot && BACKUP_CHANNEL_ID) {
    console.log('📡 Telegram backup enabled');
    setTimeout(() => restoreAllSitesFromTelegram(), 2000);
  } else {
    console.log('⚠️  Telegram backup disabled (set BOT_TOKEN and BACKUP_CHANNEL_ID in .env)');
  }
});
