'use strict';

const firebase = require('firebase-admin');
const session = require('express-session');

function firestore() {
  if (!firebase.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    const credential = raw ? firebase.credential.cert(JSON.parse(raw)) : firebase.credential.applicationDefault();
    firebase.initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  }
  return firebase.firestore();
}

class FirestoreSessionStore extends session.Store {
  constructor(db, collectionName) {
    super();
    this.collection = db.collection(collectionName);
  }
  get(sid, callback) {
    this.collection.doc(sid).get().then(snapshot => {
      const data = snapshot.data();
      if (!data || data.expiresAt <= Date.now()) return callback(null, null);
      callback(null, data.session);
    }).catch(callback);
  }
  set(sid, value, callback) {
    const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 86400000;
    this.collection.doc(sid).set({ session: JSON.parse(JSON.stringify(value)), expiresAt }).then(() => callback?.()).catch(callback);
  }
  destroy(sid, callback) {
    this.collection.doc(sid).delete().then(() => callback?.()).catch(callback);
  }
  touch(sid, value, callback) { this.set(sid, value, callback); }
}

module.exports = { firestore, FirestoreSessionStore, firebase };
