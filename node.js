const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = 3000;
const clients = {}; // Store client sessions and QR code cache by user ID

const QR_CACHE_DURATION = 20000; // Cache duration of 20 seconds

// Handle global process-level errors to prevent crashes
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Optional: Notify monitoring service, etc.
    // Recommended to restart the process in production to ensure stability
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optional: Log, notify monitoring service, etc.
});

// Middleware to verify secret header
const verifySecretHeader = (req, res, next) => {
    const secretHeader = req.headers['secret'];
    const expectedSecret = process.env.WHATSAPP_INTERNAL_SECRET_KEY;

    if (!secretHeader || secretHeader !== expectedSecret) {
        return res.status(401).json({
            status: 'error',
            message: 'Unauthorized: Invalid secret header'
        });
    }
    next();
};

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(verifySecretHeader);

const initializeClient = (userId, res) => {
    try {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: userId }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            }
        });

        clients[userId] = { client, isReady: false, qrCode: null, qrGeneratedAt: null };

        // Flag to ensure we only respond once
        let responseSent = false;

        client.on('qr', (qr) => {
            if (!responseSent) {
                qrcode.toDataURL(qr, (err, url) => {
                    if (err) {
                        console.error("Error generating QR code:", err);
                        if (!responseSent) {
                            res.status(500).json({ status: 'error', message: 'QR generation failed' });
                            responseSent = true;
                        }
                        return;
                    }
                    // Cache the QR code and timestamp
                    clients[userId].qrCode = url;
                    clients[userId].qrGeneratedAt = Date.now();
                    if (!responseSent) {
                        res.json({ qr: url });
                        responseSent = true;
                    }
                });
            }
        });

        client.on('ready', () => {
            console.log(`Client for user ${userId} is ready!`);
            clients[userId].isReady = true;
            clients[userId].qrCode = null; // Clear cached QR code once session is ready
            clients[userId].qrGeneratedAt = null;
        });

        client.on('auth_failure', () => {
            console.log(`Authentication failure for user ${userId}`);
            clients[userId].isReady = false;
            delete clients[userId]; // Clear invalid session
        });

        client.on('disconnected', (reason) => {
            console.log(`Client for user ${userId} disconnected: ${reason}`);
            clients[userId].isReady = false;
            client.removeAllListeners(); // Clear all event listeners to prevent additional responses
            delete clients[userId];
        });

        client.initialize();
    } catch (error) {
        console.error('Error initializing client:', error);
        res.status(500).json({ status: 'error', message: 'Failed to initialize client' });
    }
};

app.get('/get-qr/:userId', (req, res, next) => {
    try {
        const userId = req.params.userId;

        if (clients[userId] && clients[userId].isReady) {
            return res.json({ status: 'success', message: 'Session already active' });
        }

        // Check if a cached QR code exists and is within the 20-second cache duration
        if (clients[userId] && clients[userId].qrCode && 
            Date.now() - clients[userId].qrGeneratedAt < QR_CACHE_DURATION) {
            return res.json({ qr: clients[userId].qrCode }); // Return cached QR code
        }

        // Initialize client if no cached QR code or cache is expired
        initializeClient(userId, res);
    } catch (error) {
        console.error('Error in /get-qr route:', error);
        next(error); // Pass to centralized error handler
    }
});

app.get('/check-active/:userId', (req, res, next) => {
    try {
        const userId = req.params.userId;
        if (clients[userId] && clients[userId].isReady) {
            res.json({ status: 'success', message: 'Session already active' });
        } else {
            res.json({ status: 'error', message: 'Session NOT active' });
        }
    } catch (error) {
        console.error('Error in /check-active route:', error);
        next(error);
    }
});

app.post('/send-message/:userId', async (req, res, next) => {
    try {
        const userId = req.params.userId;
        const { phoneNumber, message } = req.body;

        if (!clients[userId] || !clients[userId].isReady) {
            return res.status(400).json({ status: 'error', message: 'User session is not ready or is inactive' });
        }

        const validPhoneNumberRegex = /^[1-9]\d{10,14}$/;
        const fullPhoneNumber = `${phoneNumber}@c.us`;

        if (!validPhoneNumberRegex.test(phoneNumber)) {
            return res.status(400).json({
                status: "error",
                message: `Invalid phone number format: ${phoneNumber}`
            });
        }

        const client = clients[userId].client;
        const response = await client.sendMessage(fullPhoneNumber, message);
        res.json({ status: 'success', response });
    } catch (error) {
        console.error("Error sending message:", error);
        next(error);
    }
});

app.post('/send-bulk-messages/:userId', async (req, res, next) => {
    try {
        const userId = req.params.userId;
        const messageList = req.body;

        if (!clients[userId] || !clients[userId].isReady) {
            return res.status(400).json({ status: 'error', message: 'Session not ready or does not exist' });
        }

        const client = clients[userId].client;
        const results = {};

        for (const [phoneNumber, message] of Object.entries(messageList)) {
            try {
                const response = await client.sendMessage(`${phoneNumber}@c.us`, message);
                results[phoneNumber] = { status: 'success', response };
            } catch (error) {
                console.error(`Error sending message to ${phoneNumber}:`, error.message || error);
                results[phoneNumber] = {
                    status: 'error',
                    error: error.message || "An error occurred",
                    type: error.name || 'UnknownError',
                    details: error.stack || 'No stack trace available'
                };
            }
        }
        res.json(results);
    } catch (error) {
        console.error('Error in /send-bulk-messages route:', error);
        next(error);
    }
});

// Centralized error-handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ status: 'error', message: 'An unexpected error occurred.' });
});

app.listen(port, () => {
    console.log(`WhatsApp server listening on port ${port}`);
});