const admin = require('firebase-admin');

// This prevents re-initializing the app on every hot-reload
if (!admin.apps.length) {
  try {
    // Check if the Base64 encoded key is available
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64) {
      console.log('Using Base64 encoded Firebase service account key');
      
      try {
        // Decode the Base64 string to get the JSON object
        const serviceAccountJson = Buffer.from(
          process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64, 
          'base64'
        ).toString('utf8');
        
        // Parse the JSON
        const serviceAccount = JSON.parse(serviceAccountJson);
        
        // Verify required fields exist
        if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
          throw new Error('Invalid service account JSON: missing required fields');
        }

        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET
        });
        
        console.log('✓ Firebase Admin initialized successfully with Base64 key');

      } catch (decodeError) {
        console.error('Error decoding Base64 Firebase key:', decodeError.message);
        throw new Error('Failed to decode FIREBASE_SERVICE_ACCOUNT_KEY_BASE64. Please verify the environment variable is properly Base64 encoded.');
      }

    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      // Fallback to the old method if the new variable isn't set
      console.log('Using separate Firebase environment variables.');
      
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET
      });
      
      console.log('✓ Firebase Admin initialized successfully with separate variables');
      
    } else {
      throw new Error('No Firebase credentials found. Please set either FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 or individual Firebase environment variables.');
    }
    
  } catch (error) {
    console.error('Firebase admin initialization error:', error.message);
    console.error('Stack:', error.stack);
    
    // Don't throw - let the app start but log the error
    // This allows health checks to report degraded status
  }
}

module.exports = admin;
