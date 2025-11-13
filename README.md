<div align="center">

# 🚀 Static Site Hosting Platform

### A blazing-fast, lightweight Node.js static site hosting solution

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.18+-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

**[Features](#-features)** •
**[Demo](#-demo)** •
**[Installation](#-installation)** •
**[Usage](#-usage)** •
**[Deployment](#-deployment)** •
**[API](#-api-documentation)**

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Demo](#-demo)
- [Tech Stack](#-tech-stack)
- [Installation](#-installation)
- [Usage](#-usage)
- [Deployment](#-deployment)
- [API Documentation](#-api-documentation)
- [Project Structure](#-project-structure)
- [Security](#-security)
- [Contributing](#-contributing)
- [License](#-license)
- [Author](#-author)

---

## 🌟 Overview

**Static Site Hosting Platform** is a production-ready, single-folder Node.js application that allows users to upload, host, and manage static websites with zero configuration. Built with performance and simplicity in mind, this platform features a clean admin panel, SQLite database for efficient site management, and robust security measures.

Perfect for developers who need a quick, self-hosted solution for managing multiple static sites without the complexity of traditional hosting platforms.

---

## ✨ Features

### Core Functionality
- 📦 **Multi-Format Upload**: Support for `.zip`, `.html`, `.css`, `.js`, and image files
- 🔐 **Automatic ZIP Extraction**: Intelligent extraction with forbidden file type blocking
- 🏷️ **Smart Slug Generation**: Auto-sanitized URLs from site names
- 📊 **SQLite Database**: Lightweight, serverless database with zero configuration
- 🎨 **Beautiful UI**: Gradient-based, responsive design with card layouts

### Admin Panel
- 📋 **Site Management**: View, delete, restore, and download all hosted sites
- 📈 **Usage Statistics**: Real-time tracking of total sites and storage consumption
- 🔄 **Soft Delete System**: Safely delete and restore sites without data loss
- 💾 **Bulk Download**: Export any site as a ZIP file

### Security & Performance
- 🛡️ **Helmet.js Integration**: Enhanced security headers and XSS protection
- ⚡ **Rate Limiting**: API endpoint protection with configurable limits (100 req/15min)
- 🧹 **File Sanitization**: Comprehensive filename and extension validation
- 🚫 **Forbidden File Blocking**: Automatic rejection of `.php`, `.py`, `.sh`, `.exe`, etc.

### Developer Experience
- 🎯 **Single Command Start**: `node server.js` — no build step required
- 🐳 **Docker Ready**: Included Dockerfile and docker-compose.yml
- 📱 **Mobile Friendly**: Fully responsive admin panel and upload interface
- 🔌 **RESTful API**: Clean, documented API endpoints

---

## 🎬 Demo

### Upload Interface
┌─────────────────────────────────────┐
│ 🚀 Static Site Hosting │
│ Upload your files and host them │
│ │
│ Total Sites: 5 Storage: 12.4 MB │
│ │
│ Site Name: [My Portfolio] │
│ File: [Choose File] portfolio.zip │
│ [Upload Site] │
└─────────────────────────────────────┘

text

### Admin Panel
┌─────────────────────────────────────────────────────┐
│ ⚙️ Admin Panel │
│ [← Back] [🔄 Refresh] │
│ │
│ Name Slug Size Status Actions│
│ Portfolio my-portfolio 2.3 MB Active [View] │
│ Blog tech-blog 5.1 MB Active [View] │
│ Landing landing-page 1.2 MB Deleted [Restore]│
└─────────────────────────────────────────────────────┘

text

---

## 🛠️ Tech Stack

| Category        | Technology                |
|-----------------|---------------------------|
| **Runtime**     | Node.js 18+               |
| **Framework**   | Express 4.18              |
| **Database**    | SQLite (better-sqlite3)   |
| **Security**    | Helmet, express-rate-limit|
| **File Handling**| adm-zip, sanitize-filename|
| **Frontend**    | Vanilla HTML/CSS/JS       |

---

## 📥 Installation

### Prerequisites

- **Node.js 18+** installed on your system
- **npm** or **yarn** package manager

### Quick Start

1. **Clone the repository**
git clone https://github.com/yourusername/static-site-hosting.git
cd static-site-hosting

text

2. **Install dependencies**
npm install

text

3. **Start the server**
node server.js

text

4. **Access the application**
- Homepage: http://localhost:3000
- Admin Panel: http://localhost:3000/admin.html

---

## 🚀 Usage

### Uploading a Site

1. Navigate to the homepage
2. Enter your site name (e.g., "My Portfolio")
3. Choose a file:
- **Single file**: `.html`, `.css`, `.js`, or image files
- **Complete site**: `.zip` archive containing all files
4. Click "Upload Site"
5. Your site will be live at: `http://your-domain/view.php?site=your-site-slug`

### Managing Sites

1. Go to `/admin.html`
2. View all uploaded sites with statistics
3. Available actions:
- **View**: Open the hosted site in a new tab
- **Delete**: Soft-delete the site (moves to `.deleted` folder)
- **Restore**: Restore a previously deleted site
- **Download**: Export the site as a ZIP file

### Viewing a Site

Sites are accessible via:
http://your-domain/view.php?site=site-slug

text

---

## 🌐 Deployment

### Deploy on Render

1. **Push to GitHub**
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/static-site-hosting.git
git push -u origin main

text

2. **Create Render Web Service**
- Go to [render.com](https://render.com)
- Click "New +" → "Web Service"
- Connect your GitHub repository
- Configure:
  ```
  Name: static-site-hosting
  Environment: Node
  Build Command: npm install
  Start Command: node server.js
  ```

3. **Deploy**
- Click "Create Web Service"
- Your app will be live in minutes!

### Deploy with Docker

Build image
docker build -t static-hosting .

Run container
docker run -p 3000:3000 -v $(pwd)/sites:/app/sites static-hosting

text

Or use Docker Compose:
docker-compose up -d

text

---

## 📚 API Documentation

### Upload Site
POST /api/upload
Content-Type: application/json

{
"siteName": "My Portfolio",
"fileName": "portfolio.zip",
"fileData": "<base64-encoded-file>"
}

text

**Response:**
{
"ok": true,
"url": "http://localhost:3000/view.php?site=my-portfolio",
"slug": "my-portfolio",
"message": "Site uploaded successfully"
}

text

### Get All Sites
GET /api/admin/sites

text

**Response:**
{
"ok": true,
"sites": [
{
"id": 1,
"name": "My Portfolio",
"slug": "my-portfolio",
"size_bytes": 2457600,
"status": "active",
"created_at": "2025-11-13T04:44:00.000Z"
}
]
}

text

### Delete Site
POST /api/admin/site/:slug/delete

text

### Restore Site
POST /api/admin/site/:slug/restore

text

### Get Usage Statistics
GET /api/admin/usage

text

**Response:**
{
"ok": true,
"totalSites": 5,
"totalStorage": 12845056,
"totalStorageFormatted": "12.25 MB"
}

text

### Download Site
GET /api/admin/site/:slug/download

text

---

## 📁 Project Structure

static-site-hosting/
├── server.js # Main Express server
├── package.json # Dependencies and scripts
├── scripts/
│ └── init-db.js # Database initialization
├── public/
│ ├── index.html # Upload interface
│ ├── admin.html # Admin panel
│ └── styles.css # Stylesheet
├── sites/ # Hosted sites (auto-created)
│ ├── site-1/
│ ├── site-2/
│ └── .deleted/ # Soft-deleted sites
├── data.db # SQLite database (auto-created)
├── Dockerfile # Docker configuration (optional)
├── docker-compose.yml # Docker Compose config (optional)
└── README.md # Documentation

text

---

## 🔒 Security

This platform implements multiple security layers:

- **Helmet.js**: Protects against common web vulnerabilities
- **Rate Limiting**: Prevents abuse with 100 requests per 15 minutes per IP
- **File Sanitization**: All filenames are sanitized using `sanitize-filename`
- **Extension Validation**: Only whitelisted file types are accepted
- **ZIP Content Scanning**: Forbidden file types (`.php`, `.py`, `.sh`, `.exe`, etc.) are blocked
- **SQL Injection Protection**: Prepared statements via better-sqlite3

### Allowed Extensions
`.zip`, `.html`, `.css`, `.js`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.gif`, `.webp`, `.ico`, `.txt`, `.json`

### Blocked Extensions
`.php`, `.py`, `.sh`, `.env`, `.exe`, `.dll`, `.bat`, `.cmd`

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. **Fork the repository**
2. **Create a feature branch**
git checkout -b feature/amazing-feature

text
3. **Commit your changes**
git commit -m 'Add amazing feature'

text
4. **Push to the branch**
git push origin feature/amazing-feature

text
5. **Open a Pull Request**

### Coding Standards
- Use ES6+ JavaScript
- Follow existing code style
- Add comments for complex logic
- Test your changes locally

---

## 📝 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

## 👨‍💻 Author

**Ayan Sayyad**

- GitHub: [@yourusername](https://github.com/yourusername)
- LinkedIn: [Your Name](https://linkedin.com/in/yourprofile)
- Email: your.email@example.com

---

## 🙏 Acknowledgments

- [Express.js](https://expressjs.com/) - Fast, unopinionated web framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - The fastest SQLite library for Node.js
- [Helmet.js](https://helmetjs.github.io/) - Security middleware
- [adm-zip](https://github.com/cthackers/adm-zip) - ZIP file handling

---

## 📊 Stats

![GitHub Stars](https://img.shields.io/github/stars/yourusername/static-site-hosting?style=social)
![GitHub Forks](https://img.shields.io/github/forks/yourusername/static-site-hosting?style=social)
![GitHub Issues](https://img.shields.io/github/issues/yourusername/static-site-hosting)
![GitHub Pull Requests](https://img.shields.io/github/issues-pr/yourusername/static-site-hosting)

---

<div align="center">

### ⭐ Star this repository if you find it helpful!

**Made with ❤️ by Ayan Sayyad**

</div>
