const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = 3000;
const clients = {}; // Store client sessions by user ID

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
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    clients[userId] = { client, isReady: false, qrSent: false };

    // Listen for the QR code event once to avoid multiple responses
    client.once('qr', (qr) => {
        if (!clients[userId].qrSent) {
            qrcode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error("Error generating QR code:", err);
                    return res.status(500).json({ status: 'error', message: 'QR generation failed' });
                }
                clients[userId].qrSent = true; // Mark the QR code as sent
                res.json({ qr: url });
            });
        }
    });

    client.on('ready', () => {
        console.log(`Client for user ${userId} is ready!`);
        clients[userId].isReady = true;
        clients[userId].qrSent = false; // Reset QR sent flag on successful login
    });

    client.on('auth_failure', () => {
        console.log(`Authentication failure for user ${userId}`);
        clients[userId].isReady = false;
        clients[userId].qrSent = false;
        delete clients[userId]; // Clear invalid session
    });

    client.on('disconnected', (reason) => {
        console.log(`Client for user ${userId} disconnected: ${reason}`);
        clients[userId].isReady = false;
        clients[userId].qrSent = false;
        delete clients[userId]; // Clear session on disconnect
    });

    client.initialize();
};

app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;

    if (clients[userId] && clients[userId].isReady) {
        res.json({ status: 'success', message: 'Session already active' });
    } else {
        initializeClient(userId, res);
    }
});

app.get('/check-active/:userId', (req, res) => {
    const userId = req.params.userId;
    if (clients[userId] && clients[userId].isReady) {
        res.json({ status: 'success', message: 'Session already active' });
    } else {
        res.json({ status: 'error', message: 'Session NOT active' });
    }
});

app.post('/send-message/:userId', (req, res) => {
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
    client.sendMessage(fullPhoneNumber, message)
        .then(response => res.json({ status: 'success', response }))
        .catch(error => {
            console.error("Error sending message:", error.message);
            res.status(500).json({
                status: "error",
                error: error.message || "Unknown error occurred"
            });
        });
});

app.post('/send-bulk-messages/:userId', async (req, res) => {
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
});

app.listen(port, () => {
    console.log(`WhatsApp server listening on port ${port}`);
});