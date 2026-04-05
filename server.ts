import express from 'express';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';

const MANIFEST = {
    id: 'org.subtitlecat.v28',
    version: '1.2.8',
    name: 'SubtitleCat Subtitles',
    description: 'Ondertitels van SubtitleCat.com (v28)',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

// Language mapping from SubtitleCat names to Stremio codes
const LANG_MAP: Record<string, string> = {
    'dutch': 'dut',
    'english': 'eng',
    'french': 'fre',
    'german': 'ger',
    'spanish': 'spa',
    'italian': 'ita',
    'portuguese': 'por',
    'russian': 'rus',
    'turkish': 'tur',
    'polish': 'pol'
};

function mapLanguage(lang: string): string {
    const l = lang.toLowerCase();
    return LANG_MAP[l] || l;
}

async function searchSubtitleCat(query: string, type: string, season?: string, episode?: string, host?: string) {
    try {
        // Try multiple search variations
        const searchQueries = [query];
        if (type === 'series' && season && episode) {
            const s = season.padStart(2, '0');
            const e = episode.padStart(2, '0');
            searchQueries.unshift(`${query} S${s}E${e}`);
            searchQueries.unshift(`${query}.${s}x${e}`);
        }

        let allResults: any[] = [];
        
        for (const q of searchQueries) {
            const searchUrl = `https://subtitlecat.com/index.php?search=${encodeURIComponent(q)}`;
            console.log(`[DEBUG] Searching SubtitleCat: ${searchUrl}`);
            
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 5000
            });
            const $ = cheerio.load(response.data);

            $('table.table tr').each((i, el) => {
                if (i === 0) return;
                const link = $(el).find('td:nth-child(1) a');
                const title = link.text().trim();
                const href = link.attr('href'); // e.g. subs/1258/filename.html
                const lang = $(el).find('td:nth-child(2)').text().trim();

                if (href && href.startsWith('subs/')) {
                    const parts = href.split('/');
                    const subId = parts[1];
                    const filename = parts[2].replace('.html', '');
                    
                    // Use our proxy to avoid CORS issues
                    const baseUrl = host ? `https://${host}` : '';
                    const dutchProxyUrl = `${baseUrl}/proxy/${subId}/${filename}/dutch.srt`;
                    const originalProxyUrl = `${baseUrl}/proxy/${subId}/${filename}.srt`;

                    // Add Dutch translation
                    allResults.push({
                        url: dutchProxyUrl,
                        lang: 'dut',
                        id: `${subId}-${filename}-dut`,
                        label: `SubtitleCat: ${title} (NL)`
                    });

                    // Add original if it's not Dutch
                    if (lang.toLowerCase() !== 'dutch') {
                        allResults.push({
                            url: originalProxyUrl,
                            lang: mapLanguage(lang),
                            id: `${subId}-${filename}-orig`,
                            label: `SubtitleCat: ${title} (${lang})`
                        });
                    }
                }
            });
            
            if (allResults.length > 0) break; // Stop if we found something
        }
        
        // Remove duplicates
        const uniqueResults = Array.from(new Map(allResults.map(item => [item.url, item])).values());
        console.log(`[DEBUG] Found ${uniqueResults.length} unique subtitle options`);
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

    // Subtitle route
    app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
        try {
            const { type, id } = req.params;
            const meta = await getMetadata(type, id);
            if (!meta) return res.json({ subtitles: [] });

            let season, episode;
            if (type === 'series') {
                const parts = id.split(':');
                season = parts[1];
                episode = parts[2];
            }

            const host = req.headers.host;
            const subtitles = await searchSubtitleCat(meta.name, type, season, episode, host);
            res.json({ subtitles });
        } catch (err) {
            console.error('Subtitle route error:', err);
            res.status(500).json({ subtitles: [] });
        }
    });

    // Proxy route to handle CORS and direct downloads
    app.get('/proxy/:id/:filename/:lang?', async (req, res) => {
        try {
            const { id, filename, lang } = req.params;
            const downloadPath = lang ? `${filename}/${lang}` : filename;
            const url = `https://subtitlecat.com/download/${id}/${downloadPath}`;
            
            console.log(`[DEBUG] Proxying subtitle: ${url}`);
            
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': 'https://subtitlecat.com/'
                },
                timeout: 10000
            });

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(response.data);
        } catch (e: any) {
            console.error('Proxy error:', e.message);
            res.status(404).send('Subtitle not found');
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
