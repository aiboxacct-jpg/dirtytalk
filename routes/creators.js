// A creator's public profile: bio, tip buttons, and a private-chat starter.
const express = require('express');
const db = require('../db');
const { tipLinks } = require('../tips');
const { findThread, threadMessages } = require('./dm');

const router = express.Router();

router.get('/:id', async (req, res) => {
  const param = req.params.id;
  const cols = 'id, name, handle, gender, bio, cashapp, venmo, paypal, revolut, crypto, verified, avatar_url, is_buyer';
  let creator = await db.get(`SELECT ${cols} FROM users WHERE handle = ?`, param);
  if (!creator && /^\d+$/.test(param)) {
    creator = await db.get(`SELECT ${cols} FROM users WHERE id = ?`, param);
  }
  if (!creator || creator.is_buyer) {
    return res.status(404).render('error', { title: 'Not found', message: 'That person does not exist.' });
  }
  const isOwner = !!req.user && req.user.id === creator.id;

  let thread = null;
  let messages = [];
  if (!isOwner) {
    thread = await findThread(creator.id, req);
    if (thread) messages = await threadMessages(thread.id);
  }

  res.render('profile', {
    title: creator.name,
    creator,
    isOwner,
    thread,
    messages,
    tips: tipLinks(creator),
  });
});

module.exports = router;
