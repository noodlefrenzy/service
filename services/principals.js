var async = require('async')
  , config = require('../config')
  , crypto = require('crypto')
  , log = require('../log')
  , models = require('../models')
  , moment = require('moment')
  , mongoose = require('mongoose')
  , nitrogen = require('nitrogen')
  , services = require('../services')
  , ursa = require('ursa')
  , utils = require('../utils');

var DEVICE_AUTH_FAILURE_MESSAGE = "The device authentication details provided were not accepted.";
var USER_AUTH_FAILURE_MESSAGE = "The email or password provided were not accepted.";

// TODO: Remove once legacy user authentication endpoint is no longer needed.
var legacyAccessTokenLookup = function(callback) {
    return function(err, principal) {
        if (err) return callback(err);

        services.accessTokens.findOrCreateToken(principal, function(err, accessToken) {
            if (err) return callback(err);

            log.debug("authenticated user principal: " + principal.id);
            callback(null, principal, accessToken);
        });
    };
};

// TODO: Remove once legacy user authentication endpoint is removed.
var legacyAuthentication = function(authBody, callback) {
    if (authBody.email && authBody.password) {
        authenticateUser(authBody.email, authBody.password, legacyAccessTokenLookup(callback));
    } else {
        callback(utils.authenticationError('Please sign in with your email and password.'));
    }
};

var accessTokenFor = function(authzPrincipal, principalId, options, callback) {

    findByIdCached(services.principals.servicePrincipal, principalId, function(err, accessTokenPrincipal) {
        if (err) return callback(err);
        if (!principalId) return callback(utils.notFoundError());

        services.permissions.authorize({
            principal: authzPrincipal.id,
            principal_for: principalId,
            action: 'admin'
        }, accessTokenPrincipal, function(err, permission) {
            if (err) return callback(err);
            if (!permission.authorized)  {
                return callback(utils.authorizationError('Principal ' + authzPrincipal.id + ' does not have an admin permission for this principal.'));
            }

            services.accessTokens.create(accessTokenPrincipal, options, function(err, accessToken) {
                if (err) return callback(err);

                log.info("principal service: principal " + authzPrincipal.id + " created access token for principal: " + principalId + " via permission: " + permission);
                callback(null, accessToken);
            });
        });
    });
};

var authenticateUser = function(email, password, callback) {
    findByEmail(services.principals.servicePrincipal, email, function(err, principal) {
        if (err) return callback(err);
        if (!principal) return callback(utils.authenticationError(USER_AUTH_FAILURE_MESSAGE));

        log.debug("found user email: " + email + " verifying password.");
        verifyPassword(password, principal, function(err) {
            if (err) return callback(err);

            return callback(null, principal);
        });
    });
};

var cacheKeyPrincipalId = function(principalId) {
    return "id." + principalId;
};

var clearCacheEntry = function(principalId, callback) {
    var cacheKey = cacheKeyPrincipalId(principalId);
    log.debug('principals: clearing cache entry ' + cacheKey);

    config.cache_provider.del('principals', cacheKey, callback);
};

var changePassword = function(principal, newPassword, callback) {
    principal.password = newPassword;
    createUserCredentials(principal, function(err, principal) {
        if (err) return callback(err);

        // changing a user's password always invalidates all current access tokens.
        services.accessTokens.removeByPrincipal(principal, function(err) {
            if (err) return callback(err);

            // but create a new token for this user and return it in the callback.
            services.accessTokens.findOrCreateToken(principal, function(err, accessToken) {

                update(services.principals.servicePrincipal, principal.id, {
                    salt: principal.salt,
                    password_hash: principal.password_hash
                }, function(err, principal) {
                    return callback(err, principal, accessToken);
                });
            });
        });
    });
};

var create = function(principal, callback) {
    validate(principal, function(err) {
        if (err) return callback(err);

        checkForExistingPrincipal(principal, function(err, foundPrincipal) {
            if (err) return callback(err);
            if (foundPrincipal) return callback(utils.badRequestError('A user with that email already exists.  Please sign in with your email and password.'));

            createCredentials(principal, function(err, principal) {
                if (err) return callback(err);

                principal.save(function(err, principal) {
                    if (err) return callback(err);

                    createPermissions(principal, function(err) {
                        if (err) return callback(err);

                        log.info("created " + principal.type + " principal: " + principal.id);

                        findByIdCached(services.principals.servicePrincipal, principal.id, function(err, updatedPrincipal) {
                            if (err) return callback(err);

                            notifySubscriptions(updatedPrincipal, function(err) {
                                if (err) return callback(err);

                                if (principal.is('reactor')) {
                                    return initializeIfFirstReactor(updatedPrincipal, callback);
                                } else {
                                    return callback(err, updatedPrincipal);
                                }
                            });
                        });
                    });
                });
            });
        });
    });
};

var initializeIfFirstReactor = function(reactor, callback) {
    find(services.principals.servicePrincipal, { type: 'reactor' }, { limit: 2 }, function(err, reactors) {
        if (err) return callback(err);
        if (reactors.length !== 1) return callback(null, reactor);

        return initializeServiceReactor(reactor, callback);
    });
};

var checkForExistingPrincipal = function(principal, callback) {
    if (!services.principals.servicePrincipal) {
        log.info('principal service: not able to check for existing user because no service principal.');
        return callback(null, null);
    }

    if (principal.is('user')) {
        findByEmail(services.principals.servicePrincipal, principal.email, callback);
    } else {
        findByIdCached(services.principals.servicePrincipal, principal.id, callback);
    }
};

var createCredentials = function(principal, callback) {
    // only user credentials need to be hashed. non-users have public key.
    if (principal.is('user')) {
        services.apiKeys.assign(principal, function(err, apiKey) {
            if (err) return callback(err);

            principal.api_key = apiKey;

            createUserCredentials(principal, callback);
        });
    } else {
        issueClaimCode(principal, function(err, code) {
            if (err) return callback(err);
            principal.claim_code = code;

            return callback(null, principal);
        });
    }
};

var createPermissions = function(principal, callback) {
    if (!principal.is('service')) {
        var permission = new models.Permission({
            authorized: true,
            issued_to: principal.id,
            principal_for: principal.id,
            priority: nitrogen.Permission.NORMAL_PRIORITY
        });

        services.permissions.create(services.principals.servicePrincipal, permission, function(err) {
            if (err) return callback(err);
            if (principal.is('user')) return callback();

            services.apiKeys.findById(principal.api_key, function(err, apiKey) {
                if (err) return callback(err);

                findByIdCached(services.principals.servicePrincipal, apiKey.owner, function(err, ownerPrincipal) {
                    if (err) return callback(err);
                    if (!ownerPrincipal || !ownerPrincipal.is('user')) return callback();

                    // if api_key owner is user, give them all permissions
                    var permission = new models.Permission({
                        authorized: true,
                        issued_to: ownerPrincipal.id,
                        principal_for: principal.id,
                        priority: nitrogen.Permission.NORMAL_PRIORITY
                    });

                    update(services.principals.servicePrincipal, principal.id, { claim_code: null });

                    services.permissions.create(services.principals.servicePrincipal, permission, callback);
                });
            });
        });
    } else {
        log.info('principals service: adding blanket permission for service principal: ' + principal.id);
        var permission = new models.Permission({
            authorized: true,
            issued_to: principal.id,
            priority: 0
        });

        services.permissions.createInternal(permission, callback);
    }
};

var createUserCredentials = function(principal, callback) {
    crypto.randomBytes(config.salt_length_bytes, function(err, saltBuf) {
        if (err) return callback(err);

        hashPassword(principal.password, saltBuf, function(err, hashedPasswordBuf) {
            if (err) return callback(err);

            principal.salt = saltBuf.toString('base64');
            principal.password_hash = hashedPasswordBuf.toString('base64');

            callback(null, principal);
        });
    });
};

var filterForPrincipal = function(principal, filter) {
    if (typeof filter !== 'object') {
        log.warn('principals service: filterForPrincipal: squelching non object filter');
        filter = {};
    }

    // used only the first query during bootstrap before service principal is established.
    if (!principal && !services.principals.servicePrincipal) {
        return filter;
    }

    if (principal && principal.is('service')) {
        return filter;
    }

    filter.visible_to = principal._id;

    return filter;
};

var find = function(principal, filter, options, callback) {
    models.Principal.find(filterForPrincipal(principal, filter), null, options, callback);
};

var findByEmail = function(principal, email, callback) {
    models.Principal.findOne(filterForPrincipal(principal, { "email": email }), callback);
};

var findByIdCached = function(authzPrincipal, id, callback) {
    var cacheKey = cacheKeyPrincipalId(id);

    log.debug('looking for principalId: ' + id + ' with cache key: ' + cacheKey);

    config.cache_provider.get('principals', cacheKey, function(err, principalObj) {
        if (err) return callback(err);
        if (principalObj) {

            // check to make sure it is visible to authz principal
            if (principalObj.visible_to.indexOf(authzPrincipal.id.toString()) !== -1) {
                log.debug("principals: " + cacheKey + ": cache hit");

                var principal = new models.Principal(principalObj);

                // Mongoose by default will override the passed id with a new unique one.  Set it back.
                principal._id = mongoose.Types.ObjectId(id);

                return callback(null, principal);
            }
        }

        log.debug("principals: " + cacheKey + ": cache miss.");

        // find and cache result
        return findById(authzPrincipal, id, callback);
    });
};

var findById = function(authzPrincipal, id, callback) {

    models.Principal.findOne(filterForPrincipal(authzPrincipal, { "_id": id }), function(err, principal) {
        if (err) return callback(err);
        if (!principal) return callback(null);

        var cacheKey = cacheKeyPrincipalId(id);

        log.debug("principals: setting cache entry for " + cacheKey);

        config.cache_provider.set('principals', cacheKey, principal.toObject(), moment().add('minutes', config.principals_cache_lifetime_minutes).toDate(), function(err) {
            return callback(err, principal);
        });
    });
};

var checkClaimCode = function(code, callback) {
    find(services.principals.servicePrincipal, { claim_code: code }, {}, function (err, principals) {
        if (err) return callback(true);
        callback(principals.length > 0);
    });
};

var generateClaimCode = function() {
    var characterCode = '';
    var numberCode = '';

    var characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (var i=0; i < config.claim_code_length / 2; i++) {
        var idx = Math.floor(Math.random() * characters.length);
        characterCode += characters[idx];
        numberCode += Math.floor(Math.random() * 10);
    }

    return characterCode + '-' + numberCode;
};

var issueClaimCode = function(principal, callback) {
    if (principal.is('user')) return callback(null,null);

    var wasCollision = true;
    var claimCode = null;
    async.whilst(
        function() { return wasCollision; },
        function(callback) {
            claimCode = generateClaimCode();
            checkClaimCode(claimCode, function(collision) {
                wasCollision = collision;
                callback();
            });
        },
        function(err) {
           if (err) return callback(err);
           callback(null, claimCode);
        }
    );

};

var hashPassword = function(password, saltBuf, callback) {
    crypto.pbkdf2(password,
                  saltBuf,
                  config.password_hash_iterations,
                  config.password_hash_length,
                  function(err, hash) {
                      if (err) return callback(err);

                      var hashBuf = new Buffer(hash, 'binary');
                      callback(null, hashBuf);
                  }
    );
};

var hashSecret = function(secret, callback) {
    // have to create a buffer here because node's sha256 hash function expects binary encoding.
    var secretBuf = new Buffer(secret, 'base64');

    var sha256 = crypto.createHash('sha256');
    sha256.update(secretBuf.toString('binary'), 'binary');

    callback(null, sha256.digest('base64'));
};

var impersonate = function(authzPrincipal, impersonatedPrincipalId, callback) {

    findByIdCached(services.principals.servicePrincipal, impersonatedPrincipalId, function(err, impersonatedPrincipal) {
        if (err) return callback(err);
        if (!impersonatedPrincipal) return callback(utils.notFoundError());

        services.permissions.authorize({
            principal: authzPrincipal.id,
            principal_for: impersonatedPrincipalId,
            action: 'impersonate'
        }, impersonatedPrincipal, function(err, permission) {
            if (err) return callback(err);
            if (!permission.authorized)  {
                return callback(utils.authorizationError('You are not authorized to impersonate this principal.'));
            }

            services.accessTokens.findOrCreateToken(impersonatedPrincipal, function(err, accessToken) {
                if (err) return callback(err);

                log.info("principal service: principal " + authzPrincipal.id + " impersonated principal: " + impersonatedPrincipalId + " via permission: " + permission);
                callback(null, impersonatedPrincipal, accessToken);
            });
        });
    });
};

var buildReactorCommands = function(reactor) {
    var commands = [];

    config.service_applications.forEach(function(app) {
        commands.push(new models.Message({
            from: services.principals.servicePrincipal.id,
            to: reactor.id,
            type: 'reactorCommand',
            tags: [ nitrogen.CommandManager.commandTag(reactor.id) ],
            body: {
                command: 'install',
                execute_as: services.principals.servicePrincipal.id,
                instance_id: app.instance_id,
                module: app.module
            }
        }));

        commands.push(new models.Message({
            from: services.principals.servicePrincipal.id,
            to: reactor.id,
            type: 'reactorCommand',
            tags: [ nitrogen.CommandManager.commandTag(reactor.id) ],
            body: {
                command: 'start',
                instance_id: app.instance_id,
                module: app.module,
                params: app.params
            }
        }));
    });

    return commands;
};

var initializeServiceReactor = function(reactor, callback) {
    var impersonatePerm = new models.Permission({
        action: 'impersonate',
        issued_to: reactor.id,
        principal_for: services.principals.servicePrincipal.id,
        priority: nitrogen.Permission.NORMAL_PRIORITY,
        authorized: true
    });

    services.permissions.create(services.principals.servicePrincipal, impersonatePerm, function(err, permission) {
        if (err) return callback(err);
        services.messages.createMany(services.principals.servicePrincipal, buildReactorCommands(reactor), function(err) {
            if (err) return callback(err);

            return callback(null, reactor);
        });
    });
};

var initialize = function(callback) {

    // we don't use services find() here because it is a chicken and an egg visibility problem.
    // we aren't service so we can't find service. :)

    // make sure to sort by created_at so that we get the very first service principal that was created by this service
    // when it bootstrapped itself.

    models.Principal.find({ type: 'service' }, null, { sort: { created_at: 1 } }, function(err, principals) {
        if (err) return callback(err);

        if (principals.length === 0) {
            log.info("bootstrapping: creating service principal");

            var keys = ursa.generatePrivateKey(config.public_key_bits, config.public_key_exponent);

            var servicePrincipal = new models.Principal({
                name:           'Service',
                type:           'service',
                public_key:     keys.toPublicPem().toString('base64'),
                private_key:    keys.toPrivatePem().toString('base64')
            });

            create(servicePrincipal, function(err, servicePrincipal) {
                if (err) return callback(err);

                services.principals.servicePrincipal = servicePrincipal;
                return callback();
            });
        } else {
            services.principals.servicePrincipal = principals[0];
            return callback();
        }
    });
};

var notifySubscriptions = function(principal, callback) {
    services.subscriptions.publish('principal', principal, callback);
};

var removeById = function(authzPrincipal, principalId, callback) {
    findByIdCached(authzPrincipal, principalId, function (err, principal) {
        if (err) return callback(err);
        if (!principal) return callback(utils.notFoundError());

        services.permissions.authorize({
            principal: authzPrincipal.id,
            principal_for: principalId,
            action: 'admin'
        }, principal, function(err, permission) {
            if (err) return callback(err);
            if (!permission.authorized)  {
                var authError = utils.authorizationError('You are not authorized to delete this principal.');
                log.warn('principals: removeById: auth failure: ' + JSON.stringify(authError));

                return callback(authError);
            }

            if (principal.is('user')) {
                // for user del  for other principals, we just delete the permissions.
                services.permissions.remove(services.principals.servicePrincipal, {
                    $or: [
                        { issued_to: principalId },
                        { principal_for: principalId }
                    ]
                }, function(err) {
                    if (err) return callback(err);

                    models.Principal.remove({ _id: principalId }, function(err, removedCount) {
                        if (err) return callback(err);

                        clearCacheEntry(principalId, function(err) {
                            return callback(err, removedCount);
                        })
                    });
                });

            } else {
                // only delete the permissions the authorizing principal has for non-user principals.
                services.permissions.remove(services.principals.servicePrincipal, {
                    issued_to: authzPrincipal.id,
                    principal_for: principalId
                }, callback);
            }
        });
    });
};

var resetPassword = function(authorizingPrincipal, principal, callback) {
    services.permissions.authorize({
        principal: authorizingPrincipal.id,
        principal_for: principal.id,
        action: 'admin'
    }, principal, function(err, permission) {
            if (err) return callback(err);
            if (!permission.authorized) return callback(utils.authorizationError(permission));

            log.info('principals service: reseting password for principal: ' + principal.id + ': ' + principal.email);

            generateRandomPassword(function(err, randomPassword) {
                if (err) return callback(err);

                changePassword(principal, randomPassword, function(err, principal) {
                    if (err) return callback(err);

                    var email = {
                        to: principal.email,
                        from: config.service_email_address,
                        subject: "Password Reset",      // TODO: Localization
                        text: "A password reset was requested for your Nitrogen account.  Your reset password is " + randomPassword + "\n" +
                              "Please login and change it as soon as possible."
                    };

                    services.email.send(email, function(err) {
                        return callback(err, principal);
                    });
                });
            });
        });
};

var generateRandomPassword = function(callback) {
    crypto.randomBytes(config.reset_password_length, function(err, randomPasswordBuf) {
        if (err) return callback(err);

        var randomPasswordString = randomPasswordBuf.toString('base64').substr(0, config.reset_password_length);
        return callback(null, randomPasswordString);
    });
};

var update = function(authorizingPrincipal, id, updates, callback) {
    if (!authorizingPrincipal) return callback(utils.principalRequired());
    if (!id) return callback(utils.badRequestError('Missing required argument id.'));

    findByIdCached(authorizingPrincipal, id, function(err, principal) {
        if (err) return callback(err);
        if (!principal) return callback(utils.badRequestError("Can't find principal for update."));

        services.permissions.authorize({
            principal: authorizingPrincipal.id,
            principal_for: id,
            action: 'admin'
        }, principal, function(err, permission) {
            if (err) return callback(err);
            if (!permission.authorized) return callback(utils.authorizationError(permission));

            updates.updated_at = new Date();

            models.Principal.update({ _id: id }, { $set: updates }, function (err, updateCount) {
                if (err) return callback(err);

                clearCacheEntry(id, function(err) {
                    if (err) return callback(err);

                    findByIdCached(authorizingPrincipal, id, function(err, updatedPrincipal) {
                        if (err) return callback(err);

                        notifySubscriptions(updatedPrincipal, function(err) {
                            if (err) return callback(err);

                            if (callback) return callback(err, updatedPrincipal);
                        });
                    });
                });
            });
        });
    });
};

var updateLastConnection = function(principal, ip) {
    var updates = {};

    // emit a ip message each time ip changes for principal.
    if (principal.last_ip != ip) {
        principal.last_ip = updates.last_ip = ip;

        var ipMessage = new models.Message({
            type: 'ip',
            from: principal,
            body: {
                ip_address: ip
            }
        });

        services.messages.create(services.principals.servicePrincipal, ipMessage, function(err, message) {
            if (err) log.info("principal service: creating ip message failed: " + err);
        });
    }

    // only update the last_connection at most once a minute.
    if (new Date() - principal.last_connection > 60 * 1000) {
        principal.last_connection = updates.last_connection = new Date();
    }

    if (Object.keys(updates).length > 0) {
        update(services.principals.servicePrincipal, principal.id, updates, function(err, principal) {
            if (err) return log.error("principal service: updating last connection failed: " + err);
        });
    }
};

var updateVisibleTo = function(principalId, callback) {
    log.debug("principal service: updating visible_to for: " + principalId);
    findByIdCached(services.principals.servicePrincipal, principalId, function(err, principal) {
        if (err) return callback(err);
        if (!principal) return callback();
        log.debug("principal service: updating visible_to for principal id: " + principalId);

        services.permissions.find(services.principals.servicePrincipal,
            { $or : [
                { action: 'view' },
                { action: null }
              ],
              $or : [
                { principal_for: principalId },
                { principal_for: null }
              ]
            },
            {
                sort: { priority: 1 }
            },
            function(err, permissions) {
                if (err) return callback(err);

                var visibilityMap = {};
                permissions.forEach(function(permission) {
                    if (permission.issued_to) {
                        if (!visibilityMap[permission.issued_to])
                            visibilityMap[permission.issued_to] = permission.authorized;
                    } else {
//                      // NEED TO THINK ABOUT THIS - THIS OVERRIDES ALL OF THE HIGHER PRIORITY AUTHORIZED=FALSE ACLS
//                      visibilityMap['*'] = permission.authorized;
                    }
                });

                principal.visible_to = [];
                Object.keys(visibilityMap).forEach(function(key) {
                    if (visibilityMap[key]) principal.visible_to.push(key);
                });

                log.debug("principal service: final visible_to: " + JSON.stringify(principal.visible_to));

                services.principals.update(services.principals.servicePrincipal, principalId, { visible_to: principal.visible_to }, callback);
            }
        );
    });
};

var validate = function(principal, callback) {
    var validType = false;

    models.Principal.PRINCIPAL_TYPES.forEach(function(type) {
        validType = validType || principal.type === type;
    });

    if (!validType) {
        var err = 'Principal type invalid. found: ' + principal.type;
        log.error(err);
        return callback(utils.badRequestError(err));
    }

    if (principal.is('user')) {
        if (!principal.email) return callback(utils.badRequestError("User must have email"));
        if (!principal.password) return callback(utils.badRequestError("User must have password"));
        if (principal.password.length < config.minimum_password_length) return callback(utils.badRequestError("User password must be at least " + config.minimum_password_length + " characters."));
    } else if (!principal.is('service')) {
        if (!principal.api_key) return callback(utils.badRequestError("Non-user principals must have api_key"));
        if (!principal.public_key) return callback(utils.badRequestError("Non-user principal must have public_key"));
    }

    callback(null);
};

var verifyPassword = function(password, user, callback) {
    var saltBuf = new Buffer(user.salt, 'base64');

    hashPassword(password, saltBuf, function(err, hashedPasswordBuf) {
        if (err) return callback(err);
        if (user.password_hash != hashedPasswordBuf.toString('base64'))
            return callback(utils.authenticationError(USER_AUTH_FAILURE_MESSAGE));
        else
            return callback(null);
    });
};

var verifySignature = function(nonceString, signature, callback) {
    services.nonce.find({ nonce: nonceString }, {}, function(err, nonces) {
        if (err) return callback(utils.internalError(err));
        if (!nonces || nonces.length === 0) return callback(utils.authenticationError("Nonce not found."));

        var nonce = nonces[0];

        findByIdCached(services.principals.servicePrincipal, nonce.principal, function(err, principal) {
            if (err) return callback(utils.internalError(err));
            if (!principal) return callback(utils.authenticationError("Nonce principal not found."));
            if (!principal.public_key) return callback(utils.authenticationError("Principal does not use public key to authenticate."));

            var verifier = crypto.createVerify("RSA-SHA256");
            verifier.update(nonceString);

            var publicKeyBuf = new Buffer(principal.public_key, 'base64');

            var result = verifier.verify(publicKeyBuf, signature, "base64");

            services.nonce.remove({ nonce: nonceString }, function(err) {
                if (err) return callback(err);

                if (result) {
                    return callback(null, principal);
                } else {
                    return callback(utils.authenticationError("Signature authentication failed."));
                }

            });
        });
    });
};

module.exports = {
    accessTokenFor: accessTokenFor,
    authenticateUser: authenticateUser,
    changePassword: changePassword,
    create: create,
    filterForPrincipal: filterForPrincipal,
    find: find,
    findByIdCached: findByIdCached,
    findById: findById,
    generateClaimCode: generateClaimCode,
    impersonate: impersonate,
    initialize: initialize,
    resetPassword: resetPassword,
    removeById: removeById,
    update: update,
    updateLastConnection: updateLastConnection,
    updateVisibleTo: updateVisibleTo,
    verifyPassword: verifyPassword,
    verifySignature: verifySignature,

    servicePrincipal: null,

    legacyAuthentication: legacyAuthentication
};
