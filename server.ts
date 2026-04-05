import express from 'express';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';

const MANIFEST = {
    id: 'org.subtitlecat.v20',
    version: '1.2.0',
    name: 'SubtitleCat',
    description: 'Ondertitels van SubtitleCat.com (v20)',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

// Helper to get title from IMDb ID using Cinemeta
async function getMetadata(type: string, id: string) {
    try {
        const imdbId = id.split(':')[0];
        const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        return response.data.meta;
    } catch (e) {
        console.error('Cinemeta error:', e);
        return null;
    }
}

async function searchSubtitleCat(query: string, type: string, season?: string, episode?: string) {
    try {
        const searchUrl = `https://www.subtitlecat.com/index.php?search=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(response.data);
        const results: any[] = [];

        $('table.table tr').each((i, el) => {
            if (i === 0) return;
            const link = $(el).find('td:nth-child(1) a');
            const title = link.text().trim();
            const href = link.attr('href');
            const lang = $(el).find('td:nth-child(2)').text().trim();

            if (href) {
                if (type === 'series' && season && episode) {
                    const s = season.padStart(2, '0');
                    const e = episode.padStart(2, '0');
                    const pattern = new RegExp(`S${s}E${e}`, 'i');
                    if (!pattern.test(title)) return;
                }
                results.push({
                    id: href,
                    url: `https://www.subtitlecat.com/${href}`,
                    lang: lang.toLowerCase(),
                    label: `${lang} - ${title}`
                });
            }
        });
        return results;
    } catch (e) {
        console.error('SubtitleCat search error:', e);
        return [];
    }
}

async function getDownloadLink(subPath: string) {
    try {
        const url = `https://www.subtitlecat.com/${subPath}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(response.data);
        const downloadHref = $('a[href^="download/"]').attr('href');
        return downloadHref ? `https://www.subtitlecat.com/${downloadHref}` : null;
    } catch (e) {
        console.error('SubtitleCat download link error:', e);
        return null;
    }
}

async function createServer() {
    const app = express();
    const PORT = process.env.PORT || 3000;

    // 1. NUCLEAR CORS FIX (Highest priority, before anything else)
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Stremio-User, X-Stremio-App');
        
        if (req.method === 'OPTIONS') {
            return res.status(200).send();
        }
        next();
    });

    app.use(express.json());

    // 2. Logging
    app.use((req, res, next) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        next();
    });

    // 3. Manifest Serving (Highest priority - Super-Nuclear Headers)
    const serveManifest = (req: any, res: any) => {
        console.log(`[DEBUG] Serving manifest to: ${req.headers['user-agent']}`);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
            'Access-Control-Allow-Headers': '*',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Max-Age': '86400'
        });
        res.end(JSON.stringify(MANIFEST));
    };

    // Multiple paths for maximum compatibility
    app.get('/manifest.json', serveManifest);
    app.get('/manifest.v2.json', serveManifest);
    app.get('/manifest', serveManifest);
    
    // Support for Stremio's root-level manifest discovery
    app.get('/', (req, res, next) => {
        const ua = (req.headers['user-agent'] || '').toLowerCase();
        const accept = (req.headers['accept'] || '').toLowerCase();
        const isStremio = ua.includes('stremio') || accept.includes('json') || req.query.stremio === 'true' || req.query.format === 'json';
        
        if (isStremio) {
            return serveManifest(req, res);
        }
        next();
    });

    // Subtitle route
    app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
        try {
            const { type, id } = req.params;
            console.log(`Subtitle request: ${type} ${id}`);
            const meta = await getMetadata(type, id);
            if (!meta) return res.json({ subtitles: [] });

            let season, episode;
            if (type === 'series') {
                const parts = id.split(':');
                season = parts[1];
                episode = parts[2];
            }

            const subs = await searchSubtitleCat(meta.name, type, season, episode);
            const subtitles = await Promise.all(subs.map(async (s) => {
                const downloadUrl = await getDownloadLink(s.id);
                return downloadUrl ? { url: downloadUrl, lang: s.lang, id: s.id, label: s.label } : null;
            }));

            res.json({ subtitles: subtitles.filter(s => s !== null) });
        } catch (err) {
            console.error('Subtitle route error:', err);
            res.status(500).json({ subtitles: [] });
        }
    });

    // 4. Frontend Setup
    const distPath = path.resolve(process.cwd(), 'dist');
    
    // Check environment based on NODE_ENV or APP_URL
    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.K_SERVICE !== undefined;
    
    if (isProd) {
        console.log('Serving static files from dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    } else {
        console.log('Using Vite middleware for development');
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    }

    return app;
}

// Export the app for Vercel
const appPromise = createServer();
export default appPromise;

// Only listen if not on Vercel
if (!process.env.VERCEL) {
    appPromise.then(app => {
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Addon server listening on 0.0.0.0:${PORT}`);
        });
    });
}
