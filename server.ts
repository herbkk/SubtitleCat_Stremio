import express from 'express';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';

const MANIFEST = {
    id: 'org.subtitlecat.v36',
    version: '1.3.6',
    name: 'SubtitleCat (v36) - NL Vertalingen',
    description: 'Ondertitels van SubtitleCat.com (v36)',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

// Language mapping from SubtitleCat names to Stremio codes (ISO 639-2/B)
const LANG_MAP: Record<string, string> = {
    'dutch': 'nld',
    'english': 'eng',
    'french': 'fre',
    'german': 'ger',
    'spanish': 'spa',
    'italian': 'ita',
    'portuguese': 'por',
    'russian': 'rus',
    'turkish': 'tur',
    'polish': 'pol',
    'hebrew': 'heb',
    'arabic': 'ara',
    'czech': 'cze',
    'hungarian': 'hun',
    'romanian': 'rum',
    'greek': 'gre',
    'danish': 'dan',
    'swedish': 'swe',
    'norwegian': 'nor',
    'finnish': 'fin',
    'albanian': 'sqi',
    'shqip': 'sqi'
};

function mapLanguage(lang: string): string {
    // Strictly allow only known languages, default to 'eng'
    const cleanLang = lang.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (!cleanLang) return 'eng';
    
    // Check if it's already a 3-letter code we support
    const values = Object.values(LANG_MAP);
    if (values.includes(cleanLang)) return cleanLang;
    
    return LANG_MAP[cleanLang] || 'eng';
}

async function searchSubtitleCat(query: string, type: string, season?: string, episode?: string, host?: string) {
    try {
        // Clean title: remove year in brackets like "Title (2024)" -> "Title"
        const cleanTitle = query.replace(/\s\(\d{4}\)$/, '').trim();
        
        // Try multiple search variations
        const searchQueries = [cleanTitle];
        if (type === 'series' && season && episode) {
            const s = season.padStart(2, '0');
            const e = episode.padStart(2, '0');
            searchQueries.unshift(`${cleanTitle} S${s}E${e}`);
            searchQueries.unshift(`${cleanTitle}.${s}x${e}`);
        }

        let allResults: any[] = [];
        
        // Perform searches in parallel for speed
        const searchPromises = searchQueries.map(async (q) => {
            const searchUrl = `https://subtitlecat.com/index.php?search=${encodeURIComponent(q)}`;
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 4000
            }).catch(() => null);

            if (!response || !response.data) return [];

            const $ = cheerio.load(response.data);
            const localResults: any[] = [];

            $('table.table tr').each((i, el) => {
                if (i === 0) return;
                const link = $(el).find('td:nth-child(1) a');
                const title = link.text().trim();
                const href = link.attr('href');
                const lang = $(el).find('td:nth-child(2)').text().trim();

                if (href && href.startsWith('subs/')) {
                    const parts = href.split('/');
                    const subId = parts[1];
                    const filename = parts[2].replace('.html', '');
                    
                    const baseUrl = host ? `https://${host}` : '';
                    // Use encodeURIComponent for the filename part of the proxy URL
                    const safeFilename = encodeURIComponent(filename);
                    const dutchProxyUrl = `${baseUrl}/proxy/${subId}/${safeFilename}/dutch.srt`;
                    const originalProxyUrl = `${baseUrl}/proxy/${subId}/${safeFilename}.srt`;

                    // Add Dutch translation
                    localResults.push({
                        url: dutchProxyUrl,
                        lang: 'nld',
                        id: `${subId}-${filename}-nld`,
                        label: `SubtitleCat: ${title} (NL)`
                    });

                    const mappedLang = mapLanguage(lang);
                    if (lang.toLowerCase().replace(/[^a-zA-Z]/g, '') !== 'dutch') {
                        localResults.push({
                            url: originalProxyUrl,
                            lang: mappedLang,
                            id: `${subId}-${filename}-orig`,
                            label: `SubtitleCat: ${title} (${lang})`
                        });
                    }
                }
            });
            return localResults;
        });

        const resultsArray = await Promise.all(searchPromises);
        allResults = resultsArray.flat();
        
        // Remove duplicates and limit results
        const uniqueResults = Array.from(new Map(allResults.map(item => [item.url, item])).values()).slice(0, 20);
        console.log(`[DEBUG] Found ${uniqueResults.length} unique subtitle options for "${cleanTitle}"`);
        return uniqueResults;
    } catch (e) {
        console.error('SubtitleCat search error:', e);
        return [];
    }
}

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

async function createServer() {
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Use official cors middleware for better compatibility
    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
        allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-Stremio-User', 'X-Stremio-App']
    }));

    app.use(express.json());

    // 2. Logging
    app.use((req, res, next) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        next();
    });

    // 3. Manifest Serving (Highest priority)
    const serveManifest = (req: any, res: any) => {
        console.log(`[DEBUG] Serving manifest to: ${req.headers['user-agent']}`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.json(MANIFEST);
    };

    // Multiple paths for maximum compatibility - MUST BE BEFORE OTHER ROUTES
    app.get('/manifest.json', serveManifest);
    app.get('/manifest.v2.json', serveManifest);
    app.get('/manifest', serveManifest);
    
    // Support for Stremio's root-level manifest discovery
    app.get('/', (req, res, next) => {
        const ua = (req.headers['user-agent'] || '').toLowerCase();
        const accept = (req.headers['accept'] || '').toLowerCase();
        
        // If it's Stremio, or requesting JSON, or NOT a browser, serve manifest
        const isStremio = ua.includes('stremio') || accept.includes('json') || req.query.stremio === 'true';
        const isBrowser = ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari');
        
        if (isStremio || !isBrowser) {
            return serveManifest(req, res);
        }
        // Otherwise, it's a browser, so let it fall through to the frontend
        next();
    });

    // Subtitle route - Catch all variations
    app.get('/subtitles/:type/:id/:extra?', async (req, res) => {
        try {
            let { type, id, extra } = req.params;
            
            // Clean parameters
            const cleanId = id.replace('.json', '');
            const cleanExtra = extra ? extra.replace('.json', '') : '';
            
            // Parse requested language from extra (e.g. "language=nld")
            let requestedLang = '';
            if (cleanExtra.includes('language=')) {
                requestedLang = cleanExtra.split('language=')[1].split('&')[0];
            }
            
            console.log(`[DEBUG] Subtitle request: type=${type}, id=${cleanId}, lang=${requestedLang}`);

            const meta = await getMetadata(type, cleanId);
            if (!meta) {
                console.log(`[DEBUG] No metadata found for ${cleanId}`);
                return res.json({ subtitles: [] });
            }

            let season, episode;
            if (type === 'series') {
                const parts = cleanId.split(':');
                season = parts[1];
                episode = parts[2];
            }

            const host = req.headers.host;
            const allSubtitles = await searchSubtitleCat(meta.name, type, season, episode, host);
            
            // Filter by requested language if Stremio provided one
            let filteredSubtitles = allSubtitles;
            if (requestedLang) {
                filteredSubtitles = allSubtitles.filter(s => s.lang === requestedLang);
            }
            
            res.json({ subtitles: filteredSubtitles });
        } catch (err) {
            console.error('Subtitle route error:', err);
            res.json({ subtitles: [] });
        }
    });

    // Proxy route to handle CORS and direct downloads
    app.get('/proxy/:id/:filename/:lang?', async (req, res) => {
        const { id, filename, lang } = req.params;
        try {
            // 1. Decode and clean the base filename
            let baseName = decodeURIComponent(filename);
            if (baseName.toLowerCase().endsWith('.srt')) {
                baseName = baseName.slice(0, -4);
            }
            
            // 2. Construct the SubtitleCat download path
            let downloadPath = '';
            if (lang) {
                // lang is something like "dutch.srt"
                const cleanLang = lang.replace('.srt', '');
                downloadPath = `${baseName}/${cleanLang}.srt`;
            } else {
                downloadPath = `${baseName}.srt`;
            }
            
            // 3. Encode the path components individually for maximum safety
            const encodedPath = downloadPath.split('/').map(part => encodeURIComponent(part)).join('/');
            const url = `https://subtitlecat.com/download/${id}/${encodedPath}`;
            
            console.log(`[DEBUG] Proxying to SubtitleCat: ${url}`);
            
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                    'Referer': 'https://subtitlecat.com/',
                    'Accept': '*/*'
                },
                timeout: 25000,
                validateStatus: (status) => status === 200
            });

            // Set headers for maximum Stremio compatibility
            // text/plain is often the most reliable for SRT across all Stremio platforms
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
            
            res.send(Buffer.from(response.data));
        } catch (e: any) {
            console.error(`[ERROR] Proxy failed for ${id}:`, e.message);
            res.status(404).send('Subtitle not found or SubtitleCat error');
        }
    });

    // 4. Frontend Setup
    // Use __dirname for more reliable path resolution on Vercel
    const distPath = path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distPath, 'index.html');
    
    // Check environment based on NODE_ENV or APP_URL
    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.K_SERVICE !== undefined;
    
    if (isProd) {
        console.log(`Serving static files from ${distPath}`);
        app.use(express.static(distPath));
        
        // Handle SPA routing
        app.get('*', (req, res, next) => {
            const url = req.url;
            if (url.startsWith('/subtitles') || url.startsWith('/proxy') || url.includes('manifest')) {
                return next();
            }
            res.sendFile(path.join(distPath, 'index.html'));
        });
    } else {
        console.log('Using Vite middleware for development');
        // Dynamic import to avoid loading Vite in production/Vercel
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    }

    return app;
}

// Export a function that Vercel can call
const appPromise = createServer();

export default async (req: any, res: any) => {
    const app = await appPromise;
    return app(req, res);
};

// Only listen if not on Vercel
if (!process.env.VERCEL) {
    appPromise.then(app => {
        const PORT = Number(process.env.PORT) || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Addon server listening on 0.0.0.0:${PORT}`);
        });
    });
}
