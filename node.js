const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = 3000;
const clients = {}; // Store client sessions and QR code cache by user ID

const QR_CACHE_DURATION = 20000; // Cache duration of 20 seconds
const QR_GENERATION_TIMEOUT = 15000; // 15-second timeout for generating a new QR code


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
const deleteFolderRecursive = (folderPath) => {
    if (fs.existsSync(folderPath)) {
        fs.readdirSync(folderPath).forEach((file) => {
            const currentPath = path.join(folderPath, file);
            if (fs.lstatSync(currentPath).isDirectory()) {
                // Recursively delete subdirectory
                deleteFolderRecursive(currentPath);
            } else {
                // Forcefully delete file
                fs.unlinkSync(currentPath);
            }
        });
        fs.rmdirSync(folderPath); // Remove the now-empty directory
    }
};


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(verifySecretHeader);

const initializeClient = async (userId, res) => {
    // Ensure any previous session is fully cleaned up
    if (clients[userId]) {
        try {
            await clients[userId].client.destroy();
            delete clients[userId];
        } catch (err) {
            console.error('Error during client destruction:', err);
        }
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            timeout: QR_GENERATION_TIMEOUT,
        }
    });

    clients[userId] = { client, isReady: false, qrCode: null, qrGeneratedAt: null };

    let responseSent = false;

    const generateQRCode = () => {
        return new Promise((resolve, reject) => {
            const qrTimeout = setTimeout(() => {
                reject(new Error('QR code generation timed out.'));
            }, QR_GENERATION_TIMEOUT);

            client.once('qr', async (qr) => {
                clearTimeout(qrTimeout);
                try {
                    const qrCodeUrl = await qrcode.toDataURL(qr);
                    clients[userId].qrCode = qrCodeUrl;
                    clients[userId].qrGeneratedAt = Date.now();
                    if (!responseSent) {
                        res.json({ qr: qrCodeUrl });
                        responseSent = true;
                    }
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    };

    client.on('ready', () => {
        console.log(`Client for user ${userId} is ready!`);
        clients[userId].isReady = true;
        clients[userId].qrCode = null;
        clients[userId].qrGeneratedAt = null;
    });

    client.on('auth_failure', () => {
        console.log(`Authentication failure for user ${userId}`);
        clients[userId].isReady = false;
        delete clients[userId];
    });

    client.on('disconnected', async (reason) => {
        console.log(`Client for user ${userId} disconnected: ${reason}`);
        clients[userId].isReady = false;
        try {
            await client.destroy();
            console.log(`Session for user ${userId} destroyed due to disconnection.`);
            const sessionPath = `./.wwebjs_auth/session-${userId}`;
            deleteFolderRecursive(sessionPath);
        } catch (error) {
            console.error('Error during session cleanup after disconnection:', error);
        }
        delete clients[userId];
    });

    client.initialize();

    try {
        await generateQRCode();
    } catch (error) {
        console.error("QR generation failed:", error);
        res.status(500).json({ status: 'error', message: 'Failed to generate QR code' });
    }
};

app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;

    if (clients[userId] && clients[userId].isReady) {
        return res.json({ status: 'success', message: 'Session already active' });
    }

    if (clients[userId] && clients[userId].qrCode && 
        Date.now() - clients[userId].qrGeneratedAt < QR_CACHE_DURATION) {
        return res.json({ qr: clients[userId].qrCode }); // Return cached QR code
    }

    initializeClient(userId, res).catch(error => {
        console.error("Failed to initialize client:", error);
        res.status(500).json({ status: 'error', message: 'Failed to initialize client' });
    });
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
        console.log(`sending message to ${fullPhoneNumber}, message is ${message}`);
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
                console.log(`sending message to ${phoneNumber}, message is ${message}`);
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


app.post('/logout/:userId', async (req, res, next) => {
    try {
        const userId = req.params.userId;

        if (!clients[userId]) {
            return res.status(404).json({
                status: 'error',
                message: `No active session found for user ${userId}`
            });
        }

        const client = clients[userId].client;

        try {
            // Properly destroy the client session
            await client.destroy();
            console.log(`Client for user ${userId} has been logged out and destroyed.`);

            // Delete the LocalAuth session data
            const sessionPath = `./.wwebjs_auth/session-${userId}`;
            deleteFolderRecursive(sessionPath);
            console.log(`Session data for user ${userId} has been deleted.`);
        } catch (destroyError) {
            console.error(`Error destroying client for user ${userId}:`, destroyError);
            return res.status(500).json({
                status: 'error',
                message: `Failed to log out user ${userId}`
            });
        }

        // Remove client session from memory
        delete clients[userId];

        res.json({
            status: 'success',
            message: `User ${userId} successfully logged out`
        });
    } catch (error) {
        console.error('Error in /logout route:', error);
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