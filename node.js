const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = 3000;
const clients = {}; // Store client sessions by user ID

const QR_EXPIRY_TIME = 20000; // 20 seconds

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

    clients[userId] = { client, isReady: false, qrCode: null, qrGeneratedAt: null };

    client.on('qr', (qr) => {
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error("Error generating QR code:", err);
                return res.status(500).json({ status: 'error', message: 'QR generation failed' });
            }
            // Cache the QR code and the timestamp when it was generated
            clients[userId].qrCode = url;
            clients[userId].qrGeneratedAt = Date.now();
            res.json({ qr: url });
        });
    });

    client.on('ready', () => {
        console.log(`Client for user ${userId} is ready!`);
        clients[userId].isReady = true;
        clients[userId].qrCode = null; // Clear stored QR code on successful login
        clients[userId].qrGeneratedAt = null;
    });

    client.on('auth_failure', () => {
        console.log(`Authentication failure for user ${userId}`);
        clients[userId].isReady = false;
        delete clients[userId];
    });

    client.on('disconnected', (reason) => {
        console.log(`Client for user ${userId} disconnected: ${reason}`);
        clients[userId].isReady = false;
        delete clients[userId];
    });

    client.initialize();
};

app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;

    if (clients[userId] && clients[userId].isReady) {
        return res.json({ status: 'success', message: 'Session already active' });
    } 

    // Check if QR code was generated within the expiry time
    if (clients[userId] && clients[userId].qrCode && 
        Date.now() - clients[userId].qrGeneratedAt < QR_EXPIRY_TIME) {
        // Use cached QR code if still valid
        return res.json({ qr: clients[userId].qrCode });
    }

    // If no client or expired QR code, reinitialize client to generate a new QR code
    initializeClient(userId, res);
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