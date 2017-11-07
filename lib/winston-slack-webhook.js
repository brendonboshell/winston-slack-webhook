'use strict';

var util = require('util');
var https = require('https');
var url = require('url');

var winston = require('winston');
var noop = function () { };

var SlackWebHook = exports.SlackWebHook = winston.transports.SlackWebHook = function (options) {
  options = options || {};
  this.name = options.name || 'slackWebHook';
  this.level = options.level || 'info';
  this.formatter = options.formatter || null;

  this.webhookUrl = options.webhookUrl || '';
  this.channel = options.channel || '';
  this.username = options.username || '';
  this.iconEmoji = options.iconEmoji || '';
  this.iconUrl = options.iconUrl || '';
  this.unfurlLinks = !!options.unfurlLinks;
  this.limitPerSecond = options.limitPerSecond || Infinity;
  this.limitWindowSeconds = options.limitWindowSeconds || 30;

  var parsedUrl = url.parse(this.webhookUrl);
  this.host = parsedUrl.hostname;
  this.port = parsedUrl.port || 443;
  this.path = parsedUrl.path;

  // Everytime a Slack message is sent, limitSent is incremeneted. But it also
  // decays over time using the update limitSent * e^(-\lambda * seconds).
  // Lambda is chosen such that an infinite number of messages sent at the
  // allowed rate will coverage to limitPerSecond * limitWindowSeconds.
  // So this limit is somewhat burstable by adjusting limitWindowSeconds.
  this.limitLambda = this.limitPerSecond * Math.log(1 / (this.limitPerSecond * this.limitWindowSeconds) + 1);
  this.limitSent = 0;
  this.limitLastUpdate = new Date();
  this.limitNumDiscarded = 0;
}

util.inherits(SlackWebHook, winston.Transport);

SlackWebHook.prototype.getLimitSentAtDate = function (date) {
  var secondsSinceUpdate = (date - this.limitLastUpdate) / 1000;
  var limitSentNow = this.limitSent * Math.exp(- this.limitLambda * secondsSinceUpdate);

  return limitSentNow;
};

SlackWebHook.prototype.isRateLimitExceeded = function () {
  var limitSentNow = this.getLimitSentAtDate(new Date());

  return limitSentNow > this.limitPerSecond * this.limitWindowSeconds;
};

SlackWebHook.prototype.incrementLimitSent = function () {
  var nowDate = new Date(),
      limitSentNow = this.getLimitSentAtDate(nowDate);

  this.limitSent = limitSentNow + 1;
  this.limitLastUpdate = nowDate;
};

SlackWebHook.prototype.sendSlackLog = function (level, msg, meta, callback) {
  if (typeof this.formatter === 'function') {
    msg = this.formatter({
      level: level,
      message: msg,
      meta: meta
    });
  }

  var payload = {
    text: msg,
    channel: this.channel,
    username: this.username,
    icon_emoji: this.iconEmoji,
    icon_url: this.iconUrl,
    unfurl_links: this.unfurlLinks,
  };

  if (Object.keys(meta).length > 0) {
    var color;
    switch (level) {
      case 'error': color = "danger"; break;
      case 'warn': color = "warning"; break;
      default: color = "good";
    }
    var attachments = [];
    for (let key in meta){
      if (meta.hasOwnProperty(key)) {
        attachments.push({
            fallback: util.inspect(meta[key]),
            text: `${key}: ${util.inspect(meta[key])}`,
            color: color,
        })
      }
    }
    payload.attachments = attachments;
  }

  var data = JSON.stringify(payload);

  var req = https.request({
    host: this.host,
    port: this.port,
    path: this.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  }, function (res) {
    var body = '';
    res.on('data', function (chunk) {
      body += chunk;
    });
    res.on('end', function () {
      if (res.statusCode === 200) {
        callback(null, body);
      } else {
        callback(new Error('https request fails. statusCode ' + res.statusCode + ', body ' + body));
      }
    });
  });

  req.write(data);
  req.end();
};

SlackWebHook.prototype.log = function (level, msg, meta, callback) {
  if (this.isRateLimitExceeded()) {
    this.limitNumDiscarded++;
  } else {
    if (this.limitNumDiscarded > 0) {
      this.sendSlackLog('warn', 'winston-slack-webhook discarded ' + this.limitNumDiscarded + ' messages', {}, noop);
      this.limitNumDiscarded = 0;
      this.incrementLimitSent();
    }

    this.sendSlackLog(level, msg, meta, callback);
    this.incrementLimitSent();
  }
};
