var async = require('async')
  , config = require('../config')
  , log = require('../log')
  , models = require('../models')
  ,	services = require('../services')
  , utils = require('../utils');

exports.create = function(req, res) {
    services.messages.createMany(req.user, req.body, function(err, messages) {
        if (err) return utils.handleError(res, err);

        res.send({ "messages": messages });
    });
};

exports.index = function(req, res) {
    var query = utils.parseQuery(req);
    var options = utils.parseOptions(req);

    if (!options.sort) options.sort = { ts: -1 };

    services.messages.find(req.user, query, options, function(err, messages) {
        if (err) return utils.handleError(res, err);

        res.send({ "messages": messages });
    });
};

exports.remove = function(req, res) {
    var query = utils.parseQuery(req);

    services.messages.remove(req.user, query, function(err, removed) {
        if (err) return utils.handleError(res, err);

        res.send({ "removed": removed });
    });
};

exports.show = function(req, res) {
    services.messages.findById(req.user, req.params.id, function(err, message) {
        if (err) return utils.handleError(res, err);
        if (!message) return utils.sendFailedResponse(res, 403, err);

        res.send({ "message": message });
    });
};
