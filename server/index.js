// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
// <disable>JS1001.SyntaxError</disable>

(function () {
    "use strict";

    // pull in the required packages.
    require('dotenv').config();
    const express = require('express');
    const path = require('path');
    const axios = require('axios');
    const bodyParser = require('body-parser');
    const pino = require('express-pino-logger')();
    const cors = require('cors');

    const app = express();
    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());
    app.use(pino);
    app.use(cors());

    // Helpful headers for media autoplay/testing in local dev
    app.use((req, res, next) => {
        // Allow autoplay where supported by Permissions-Policy
        res.setHeader('Permissions-Policy', 'autoplay=(self "http://localhost:3000" "http://localhost:3001")');
        // Legacy header some browsers still parse
        res.setHeader('Feature-Policy', "autoplay 'self'");
        next();
    });

    // Serve static files from ../public so /listener.html works directly on :3001
    const publicDir = path.join(__dirname, '..', 'public');

    // Route root BEFORE static so we don't auto-serve public/index.html
    app.get(['/', '/listener'], (req, res) => {
        res.sendFile(path.join(publicDir, 'listener.html'));
    });
    app.get('/speaker', (req, res) => {
        res.sendFile(path.join(publicDir, 'speaker.html'));
    });
    // Healthcheck
    app.get('/healthz', (req, res) => res.status(200).send('ok'));

    // Static after explicit routes
    app.use(express.static(publicDir));
    
    // (Removed duplicate static setup and duplicate path import)

    app.get('/api/get-speech-token', async (req, res, next) => {
        res.setHeader('Content-Type', 'application/json');
        const speechKey = process.env.SPEECH_KEY;
        const speechRegion = process.env.SPEECH_REGION;
        const speechEndpointId = process.env.SPEECH_ENDPOINT_ID || '';

        if (speechKey === 'paste-your-speech-key-here' || speechRegion === 'paste-your-speech-region-here') {
            res.status(400).send('You forgot to add your speech key or region to the .env file.');
        } else {
            const headers = { 
                headers: {
                    'Ocp-Apim-Subscription-Key': speechKey,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            };

            try {
                const tokenResponse = await axios.post(`https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, null, headers);
                res.send({ token: tokenResponse.data, region: speechRegion, endpointId: speechEndpointId });
            } catch (err) {
                res.status(401).send('There was an error authorizing your speech key.');
            }
        }
    });

    // Provide ElevenLabs API key to clients (local dev convenience)
    app.get('/api/get-eleven-key', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const apiKey = process.env.ELEVENLABS_API_KEY || '';
        res.send({ apiKey, ts: Date.now() });
    });

    // Server-side translation proxy for partials
    app.post('/api/translate', async (req, res) => {
        try {
            const endpoint = process.env.TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';
            const region = process.env.TRANSLATOR_REGION;
            const key = process.env.TRANSLATOR_KEY;
            const { text, to } = req.body || {};
            if (!key || !region || !text || !to) {
                return res.status(400).send({ error: 'Missing translator config or params' });
            }
            // Enable profanity to flow unmasked through translation responses
            const url = `${endpoint}/translate?api-version=3.0&to=${encodeURIComponent(to)}&profanityAction=NoAction`;
            const headers = {
                'Ocp-Apim-Subscription-Key': key,
                'Ocp-Apim-Subscription-Region': region,
                'Content-Type': 'application/json'
            };
            const payload = [{ Text: text }];
            const result = await axios.post(url, payload, { headers });
            const translated = result.data && result.data[0] && result.data[0].translations && result.data[0].translations[0] && result.data[0].translations[0].text;
            res.send({ text, to, translation: translated || '' });
        } catch (e) {
            res.status(500).send({ error: 'Translation failed' });
        }
    });

    const port = process.env.PORT || 3001;
    const server = app.listen(port, () => {
        console.log(`Express server is running on ${port}`);
    });

    // Simple WebSocket relay to support Speaker -> Listener messages
    try {
        const { Server } = require('ws');
        const wss = new Server({ server, path: '/ws' });
        console.log('[ws] server listening on /ws');

        function broadcast(jsonString, exclude) {
            wss.clients.forEach((client) => {
                if (client !== exclude && client.readyState === 1) {
                    client.send(jsonString);
                }
            });
        }

        wss.on('connection', (ws) => {
            console.log('[ws] client connected. total:', wss.clients.size);
            try { ws.send(JSON.stringify({ type: 'debug', message: 'ws-welcome' })); } catch(_) {}
            ws.on('message', (data) => {
                let msg;
                try {
                    msg = JSON.parse(data.toString());
                } catch (_) {
                    console.log('[ws] non-json message', String(data).slice(0, 200));
                    return;
                }
                // Forward deltas or legacy full text
                if (msg && msg.type === 'speak' && msg.payload) {
                    const p = msg.payload;
                    if (typeof p.textSuffix === 'string' || typeof p.text === 'string') {
                        const receiveTime = Date.now();
                        console.log('\n[WS-RELAY] ============ TRANSLATION RELAY ============');
                        console.log(`[WS-RELAY] 📨 Received at: ${new Date(receiveTime).toISOString()}`);
                        console.log(`[WS-RELAY] 🌐 Language: ${p.lang}`);
                        console.log(`[WS-RELAY] 🔢 Segment ID: ${p.segmentId}`);
                        console.log(`[WS-RELAY] 📍 Replace from: ${p.replaceFrom}`);
                        console.log(`[WS-RELAY] 📝 Text suffix: "${p.textSuffix ? p.textSuffix.substring(0, 100) : ''}"${p.textSuffix && p.textSuffix.length > 100 ? '...' : ''}`);
                        console.log(`[WS-RELAY] 📏 Suffix length: ${p.textSuffix ? p.textSuffix.length : 0} chars`);
                        console.log(`[WS-RELAY] 🏁 Is final: ${p.isFinal}`);
                        console.log(`[WS-RELAY] 👥 Broadcasting to ${wss.clients.size - 1} listeners`);
                        const out = JSON.stringify({ type: 'translation', payload: p });
                        broadcast(out, ws);
                        console.log(`[WS-RELAY] ✅ Broadcast complete`);
                        console.log('[WS-RELAY] ' + '─'.repeat(50) + '\n');
                    } else {
                        console.log('[ws] speak payload ignored (no text/textSuffix)');
                    }
                } else {
                    console.log('[ws] unknown message type', msg && msg.type);
                }
            });

            ws.on('error', () => {});
            ws.on('close', () => {
                console.log('[ws] client disconnected. total:', wss.clients.size);
            });
        });

        // periodic heartbeat broadcast to verify downstream reception
        setInterval(() => {
            try {
                const hb = JSON.stringify({ type: 'debug', message: 'heartbeat', ts: Date.now() });
                broadcast(hb, undefined);
            } catch(_) {}
        }, 5000);
    } catch (e) {
        console.log('WebSocket server not started (ws not installed).');
    }
}());
// </disable>
