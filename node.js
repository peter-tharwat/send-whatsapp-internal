const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { Readable } = require('stream');
require('dotenv').config();

const app = express();
const port = 3000;
const clients = {}; // Store client sessions and QR code cache by user ID

const QR_CACHE_DURATION = 20000; // Cache duration of 20 seconds
const QR_GENERATION_TIMEOUT = 15000; // 15-second timeout for generating a new QR code

// Configure AWS S3 Client
const s3 = new S3Client({
    endpoint: process.env.AWS_ENDPOINT, // AWS S3 or compatible endpoint
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Helper Functions for S3 Operations
const uploadToS3 = async (key, content) => {
    const command = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: content,
    });
    await s3.send(command);
    console.log(`Uploaded ${key} to S3.`);
};

const downloadFromS3 = async (key) => {
    const command = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
    });

    try {
        const { Body } = await s3.send(command);
        return await streamToString(Body);
    } catch (err) {
        if (err.name === 'NoSuchKey') {
            console.log(`Key ${key} does not exist in S3. This is normal for new sessions.`);
            return null; // Return null for non-existing keys
        }
        throw err; // Re-throw other errors
    }
};

// Helper to convert a stream to string
const streamToString = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
};

const deleteFromS3 = async (prefix) => {
    const listCommand = new ListObjectsV2Command({
        Bucket: process.env.AWS_BUCKET_NAME,
        Prefix: prefix,
    });

    const listedObjects = await s3.send(listCommand);
    if (!listedObjects.Contents || listedObjects.Contents.length === 0) return;

    const deleteCommand = new DeleteObjectsCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Delete: { Objects: listedObjects.Contents.map(({ Key }) => ({ Key })) },
    });

    await s3.send(deleteCommand);
    console.log(`Deleted all objects with prefix ${prefix} from S3.`);
};

// Initialize WhatsApp Client
const initializeClient = async (userId, res) => {
    const sessionPrefix = `wwebjs_auth/session-${userId}/`;

    // Download session data from S3
    const authData = await downloadFromS3(`${sessionPrefix}auth`);
    if (authData) {
        const authPath = `/tmp/session-${userId}`;
        fs.mkdirSync(authPath, { recursive: true });
        fs.writeFileSync(`${authPath}/auth`, authData);
        console.log(`Session for user ${userId} downloaded to temporary path.`);
    } else {
        console.log(`No session found for user ${userId}. A new session will be created.`);
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId, dataPath: '/tmp' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    clients[userId] = { client, isReady: false, qrCode: null, qrGeneratedAt: null };

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
                    res.json({ qr: qrCodeUrl });
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    };

    client.on('ready', async () => {
        console.log(`Client for user ${userId} is ready.`);
        clients[userId].isReady = true;

        // Upload the newly created session to S3
        setTimeout(async () => {
            const authPath = `/tmp/session-${userId}/auth`;
            console.log(`Checking for authPath: ${authPath}`);
            if (fs.existsSync(authPath)) {
                console.log(`authPath exists for user ${userId}`);
                const sessionData = fs.readFileSync(authPath);
                await uploadToS3(`${sessionPrefix}auth`, sessionData);
                console.log(`Session data for user ${userId} uploaded to S3.`);
            } else {
                console.log(`authPath does not exist for user ${userId}`);
            }
        }, 500); // Adjust delay as needed
    });

    client.initialize();

    try {
        await generateQRCode();
    } catch (error) {
        console.error('QR generation failed:', error);
        res.status(500).json({ status: 'error', message: 'Failed to generate QR code' });
    }
};

// Routes

// Get QR Code for User
app.get('/get-qr/:userId', (req, res) => {
    const userId = req.params.userId;

    if (clients[userId] && clients[userId].isReady) {
        return res.json({ status: 'success', message: 'Session already active' });
    }

    initializeClient(userId, res).catch((error) => {
        console.error('Failed to initialize client:', error);
        res.status(500).json({ status: 'error', message: 'Failed to initialize client' });
    });
});

// Check if User is Active
app.get('/check-active/:userId', (req, res) => {
    const userId = req.params.userId;
    if (clients[userId] && clients[userId].isReady) {
        res.json({ status: 'success', message: 'Session already active' });
    } else {
        res.json({ status: 'error', message: 'Session is not active' });
    }
});

// Send Message to a Single User
app.post('/send-message/:userId', async (req, res) => {
    const userId = req.params.userId;
    const { phoneNumber, message } = req.body;

    if (!clients[userId] || !clients[userId].isReady) {
        return res.status(400).json({ status: 'error', message: 'Session is not active' });
    }

    const client = clients[userId].client;

    try {
        const response = await client.sendMessage(`${phoneNumber}@c.us`, message);
        res.json({ status: 'success', response });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ status: 'error', message: 'Failed to send message' });
    }
});

// Send Bulk Messages
app.post('/send-bulk-messages/:userId', async (req, res) => {
    const userId = req.params.userId;
    const messageList = req.body;

    if (!clients[userId] || !clients[userId].isReady) {
        return res.status(400).json({ status: 'error', message: 'Session not active' });
    }

    const client = clients[userId].client;
    const results = {};

    for (const [phoneNumber, message] of Object.entries(messageList)) {
        try {
            const response = await client.sendMessage(`${phoneNumber}@c.us`, message);
            results[phoneNumber] = { status: 'success', response };
        } catch (error) {
            console.error(`Error sending message to ${phoneNumber}:`, error.message || error);
            results[phoneNumber] = { status: 'error', error: error.message || 'An error occurred' };
        }
    }

    res.json(results);
});

// Logout User and Delete Session
app.post('/logout/:userId', async (req, res) => {
    const userId = req.params.userId;
    const sessionPrefix = `wwebjs_auth/session-${userId}/`;

    if (!clients[userId]) {
        return res.status(404).json({ status: 'error', message: 'No active session found' });
    }

    try {
        await clients[userId].client.destroy();
        console.log(`Client for user ${userId} destroyed.`);

        // Delete session from S3
        await deleteFromS3(sessionPrefix);
        console.log(`Session for user ${userId} deleted from S3.`);

        delete clients[userId];
        res.json({ status: 'success', message: `User ${userId} successfully logged out.` });
    } catch (error) {
        console.error('Error during logout:', error);
        res.status(500).json({ status: 'error', message: 'Failed to log out user.' });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`WhatsApp server listening on port ${port}`);
});
