var util = require('util');
var extend = require('extend-object');
var BaseSession = require('jingle-session');
var RTCPeerConnection = require('rtcpeerconnection');
var FileTransfer = require('filetransfer/hashed');


function FileTransferSession(opts) {
    BaseSession.call(this, opts);

    this.pc = new RTCPeerConnection({
        iceServers: opts.iceServers || [],
        useJingle: true
    }, opts.constraints || {});

    this.pc.on('ice', this.onIceCandidate.bind(this));
    this.pc.on('iceConnectionStateChange', this.onIceStateChange.bind(this));
    this.pc.on('addChannel', this.onChannelAdded.bind(this));

    this.sender = null;
    this.receiver = null;
}


util.inherits(FileTransferSession, BaseSession);


FileTransferSession.prototype = extend(FileTransferSession.prototype, {

    // ----------------------------------------------------------------
    // Session control methods
    // ----------------------------------------------------------------

    start: function (file) {
        var self = this;
        this.state = 'pending';

        this.pc.isInitiator = true;

        this.sender = new FileTransfer.Sender();
        this.sender.on('progress', function (sent, size) {
            self._log('info', 'Send progress ' + sent + '/' + size);
        });
        this.sender.on('sentFile', function (meta) {
            self._log('info', 'Sent file', meta.name);

            var content = self.pc.localDescription.contents[0];
            delete content.transport;

            content.description = {
                descType: 'filetransfer',
                offer: {
                    hash: {
                        algo: meta.algo,
                        value: meta.hash
                    }
                }
            };

            self.send('description-info', {
                contents: [content]
            });
            self.emit('sentFile', self, meta);
        });

        var sendChannel = this.pc.createDataChannel('filetransfer');
        sendChannel.onopen = function () {
            self.sender.send(file, sendChannel);
        };

        var constraints = {
            mandatory: {
                OfferToReceiveAudio: false,
                OfferToReceiveVideo: false
            }
        };

        this.pc.offer(constraints, function (err, offer) {
            if (err) {
                self._log('error', 'Could not create WebRTC offer', err);
                return self.end('failed-application', true);
            }

            offer.jingle.contents[0].description = {
                descType: 'filetransfer',
                offer: {
                    date: file.lastModifiedDate,
                    name: file.name,
                    size: file.size,
                    hash: {
                        algo: 'sha-1',
                        value: ''
                    }
                }
            };

            self.send('session-initiate', offer.jingle);
        });
    },

    accept: function () {
        var self = this;

        this._log('info', 'Accepted incoming session');

        this.state = 'active';

        this.pc.answer(function (err, answer) {
            if (err) {
                self._log('error', 'Could not create WebRTC answer', err);
                return self.end('failed-application');
            }
            self.send('session-accept', answer.jingle);
        });
    },

    end: function (reason, silent) {
        this.pc.close();
        BaseSession.prototype.end.call(this, reason, silent);
    },

    maybeReceivedFile: function () {
        if (!this.receiver.metadata.hash.value) {
            // unknown hash, file transfer not completed
        } else if (this.receiver.metadata.hash.value === this.receiver.metadata.actualhash) {
            this._log('info', 'File hash matches');
            this.emit('receivedFile', this, this.receivedFile, this.receiver.metadata);
            this.end('success');
        } else {
            this._log('error', 'File hash does not match');
            this.end('media-error');
        }
    },

    // ----------------------------------------------------------------
    // ICE action handers
    // ----------------------------------------------------------------

    onIceCandidate: function (candidate) {
        this._log('info', 'Discovered new ICE candidate', candidate.jingle);
        this.send('transport-info', candidate.jingle);
    },

    onIceStateChange: function () {
        switch (this.pc.iceConnectionState) {
            case 'checking':
                this.connectionState = 'connecting';
                break;
            case 'completed':
            case 'connected':
                this.connectionState = 'connected';
                break;
            case 'disconnected':
                if (this.pc.signalingState === 'stable') {
                    this.connectionState = 'interrupted';
                } else {
                    this.connectionState = 'disconnected';
                }
                break;
            case 'failed':
                this.connectionState = 'failed';
                this.end('failed-transport');
                break;
            case 'closed':
                this.connectionState = 'disconnected';
                break;
        }
    },

    onChannelAdded: function (channel) {
        this.receiver.receive(null, channel);
    },

    // ----------------------------------------------------------------
    // Jingle action handers
    // ----------------------------------------------------------------

    onSessionInitiate: function (changes, cb) {
        var self = this;

        this._log('info', 'Initiating incoming session');

        this.state = 'pending';

        this.pc.isInitiator = false;

        var desc = changes.contents[0].description;


        this.receiver = new FileTransfer.Receiver({hash: desc.offer.hash.algo});
        this.receiver.on('progress', function (received, size) {
            self._log('info', 'Receive progress ' + received + '/' + size);
        });
        this.receiver.on('receivedFile', function (file) {
            self.receivedFile = file;
            self.maybeReceivedFile();
        });
        this.receiver.metadata = desc.offer;

        changes.contents[0].description = {
            descType: 'datachannel'
        };

        this.pc.handleOffer({
            type: 'offer',
            jingle: changes
        }, function (err) {
            if (err) {
                self._log('error', 'Could not create WebRTC answer');
                return cb({condition: 'general-error'});
            }
            cb();
        });
    },

    onSessionAccept: function (changes, cb) {
        var self = this;

        this.state = 'active';
        
        changes.contents[0].description = {
            descType: 'datachannel'
        };

        this.pc.handleAnswer({
            type: 'answer',
            jingle: changes
        }, function (err) {
            if (err) {
                self._log('error', 'Could not process WebRTC answer');
                return cb({condition: 'general-error'});
            }
            self.emit('accepted', self);
            cb();
        });
    },

    onSessionTerminate: function (changes, cb) {
        this._log('info', 'Terminating session');
        this.pc.close();
        BaseSession.prototype.end.call(this, changes.reason, true);
        cb();
    },

    onDescriptionInfo: function (info, cb) {
        var hash = info.contents[0].description.offer.hash;
        this.receiver.metadata.hash = hash;
        if (this.receiver.metadata.actualhash) {
            this.maybeReceivedFile();
        }
        cb();
    },

    onTransportInfo: function (changes, cb) {
        this.pc.processIce(changes, function () {
            cb();
        });
    }
});


module.exports = FileTransferSession;
