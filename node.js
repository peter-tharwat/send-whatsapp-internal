const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-core');

(async () => {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true  // Optional: Run in headless mode
    });
    // Your Puppeteer code here
})();

const app = express();
require('dotenv').config();

const port = 3000;
const clients = {}; // Store client sessions by user ID

const verifySecretHeader = (req, res, next) => {
    const secretHeader = req.headers['secret'];
    const expectedSecret = process.env.WHATSAPP_INTERNAL_SECRET_KEY;

    // Check if the 'secret' header is present and matches the expected value
    if (!secretHeader || secretHeader !== expectedSecret) {
        return res.status(401).json({
            status: 'error',
            message: 'Unauthorized: Invalid secret header'
        });
    }

    // If the secret is correct, proceed with the request
    next();
};

app.use( bodyParser.json() );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));
app.use(verifySecretHeader);
app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;

    // If a session already exists for the user, return that it’s ready
    if (clients[userId] && clients[userId].isReady) {
        res.json({ status: 'success',message: 'Session already active' });
        return;
    }

    // Create a new WhatsApp client with LocalAuth
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }),
    });

    clients[userId] = { client, isReady: false };

    client.on('qr', (qr) => {
        qrcode.toDataURL(qr, (err, url) => {
            res.json({ qr: url });
        });
    });

    client.on('ready', () => {
        console.log(`Client for user ${userId} is ready!`);
        clients[userId].isReady = true;
    });

    client.on('auth_failure', () => {
        console.log(`Authentication failure for user ${userId}`);
        clients[userId].isReady = false;
    });

    client.initialize();
});


app.get('/check-active/:userId', (req, res) => {
    const userId = req.params.userId;
    if (clients[userId] && clients[userId].isReady) {
        res.json({ status: 'success',message: 'Session already active' });
        return;
    }
    res.json({ status: 'error',message: 'Session NOT active' });
    return;
});


app.post('/send-message/:userId', (req, res) => {
    const userId = req.params.userId;
    const { phoneNumber, message } = req.body;

    // Check if a client exists and is ready
    if (!clients[userId]) {
        res.status(400).json({ status: 'error', message: 'User session does not exist' });
        return;
    }

    if (!clients[userId].isReady) {
        res.status(400).json({ status: 'error', message: 'User session is not ready or is inactive' });
        return;
    }

    const validPhoneNumberRegex = /^[1-9]\d{10,14}$/; // 10-15 digits for international numbers
    const fullPhoneNumber = `${phoneNumber}@c.us`;

    if (!validPhoneNumberRegex.test(phoneNumber)) {
        return res.status(400).json({
            status: "error",
            message: "Invalid phone number format" + phoneNumber
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
    const messageList = req.body; // Expecting format: { "phone1": "message1", "phone2": "message2" }

    // Check if the client session exists and is ready
    if (!clients[userId] || !clients[userId].isReady) {
        return res.status(400).json({ status: 'error', message: 'Session not ready or does not exist' });
    }

    const client = clients[userId];
    const results = {};

    for (const [phoneNumber, message] of Object.entries(messageList)) {
        try {
            const response = await client.sendMessage(`${phoneNumber}@c.us`, message);
            results[phoneNumber] = { status: 'success', response };
        } catch (error) {
            console.error(`Error sending message to ${phoneNumber}:`, error.message || error);
            results[phoneNumber] = {
                status: 'error',
                error: error.message || error,
                type: error.name || 'UnknownError',
                details: error.stack || 'No stack trace available'
            };
        }
    }

    res.json(results); // Return detailed results for each phone number
});
app.listen(port, () => {
    console.log(`WhatsApp server listening on port ${port}`);
});