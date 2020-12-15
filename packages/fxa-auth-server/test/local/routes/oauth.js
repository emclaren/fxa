/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const ROOT_DIR = '../../..';

const sinon = require('sinon');
const Joi = require('@hapi/joi');
const assert = { ...sinon.assert, ...require('chai').assert };
const getRoute = require('../../routes_helpers').getRoute;
const mocks = require('../../mocks');
const error = require('../../../lib/error');
const JWTIdToken = require(`${ROOT_DIR}/lib/oauth/jwt_id_token`);

const { OAUTH_SCOPE_OLD_SYNC } = require(`${ROOT_DIR}/lib/constants`);
const MOCK_CLIENT_ID = '0123456789abcdef';
const MOCK_USER_ID = '0123456789abcdef0123456789abcdef';
const MOCK_SCOPES = `profile https://identity.mozilla.com/apps/scoped-example ${OAUTH_SCOPE_OLD_SYNC}`;
const MOCK_UNIX_TIMESTAMP = Math.round(Date.now() / 1000);
const MOCK_TOKEN =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const MOCK_JWT =
  '001122334455.66778899aabbccddeeff00112233445566778899.aabbccddeeff';

describe('/oauth/ routes', () => {
  let mockOAuthDB, mockDB, mockLog, mockConfig, sessionToken;

  async function loadAndCallRoute(path, request) {
    const routes = require('../../../lib/routes/oauth/proxied')(
      mockConfig,
      mockOAuthDB
    ).concat(
      require('../../../lib/routes/oauth')(mockLog, mockConfig, mockDB, {}, {})
    );
    const route = await getRoute(routes, path);
    if (route.config.validate.payload) {
      // eslint-disable-next-line require-atomic-updates
      request.payload = await Joi.validate(
        request.payload,
        route.config.validate.payload,
        {
          context: {
            headers: request.headers || {},
          },
        }
      );
    }
    const response = await route.handler(request);
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  async function mockSessionToken(props = {}) {
    const Token = require(`${ROOT_DIR}/lib/tokens/token`)(mockLog);
    const SessionToken = require(`${ROOT_DIR}/lib/tokens/session_token`)(
      mockLog,
      Token,
      {
        tokenLifetimes: {
          sessionTokenWithoutDevice: 2419200000,
        },
      }
    );
    return await SessionToken.create({
      uid: MOCK_USER_ID,
      email: 'foo@example.com',
      emailVerified: true,
      ...props,
    });
  }

  beforeEach(() => {
    mockLog = mocks.mockLog();
    mockConfig = {
      oauth: {},
      oauthServer: {
        expiration: {
          accessToken: 999,
        },
        disabledClients: [],
        contentUrl: 'http://localhost:3030',
      },
    };
  });

  describe('/oauth/id-token-verify', () => {
    let MOCK_ID_TOKEN_CLAIMS, mockVerify;

    beforeEach(() => {
      MOCK_ID_TOKEN_CLAIMS = {
        iss: 'http://127.0.0.1:9000',
        alg: 'RS256',
        aud: MOCK_CLIENT_ID,
        sub: MOCK_USER_ID,
        exp: MOCK_UNIX_TIMESTAMP + 100,
        iat: MOCK_UNIX_TIMESTAMP,
        amr: ['pwd', 'otp'],
        at_hash: '47DEQpj8HBSa-_TImW-5JA',
        acr: 'AAL2',
        'fxa-aal': 2,
      };
      mockVerify = sinon.stub(JWTIdToken, 'verify');
    });

    const _testRequest = async (claims, gracePeriod) => {
      mockVerify.returns(claims);
      const payload = {
        client_id: MOCK_CLIENT_ID,
        id_token: MOCK_JWT,
      };
      if (gracePeriod) {
        payload.expiry_grace_period = gracePeriod;
      }
      const mockRequest = mocks.mockRequest({ payload });

      return await loadAndCallRoute('/oauth/id-token-verify', mockRequest);
    };

    afterEach(() => {
      mockVerify.restore();
    });

    it('calls JWTIdToken.verify', async () => {
      const resp = await _testRequest(MOCK_ID_TOKEN_CLAIMS);

      assert.calledOnce(mockVerify);
      assert.deepEqual(resp, MOCK_ID_TOKEN_CLAIMS);
      mockVerify.restore();
    });

    it('supports expiryGracePeriod option', async () => {
      const resp = await _testRequest(MOCK_ID_TOKEN_CLAIMS, 600);

      assert.calledOnce(mockVerify);
      assert.deepEqual(resp, MOCK_ID_TOKEN_CLAIMS);
      mockVerify.restore();
    });

    it('allows extra claims', async () => {
      MOCK_ID_TOKEN_CLAIMS.foo = 'bar';

      const resp = await _testRequest(MOCK_ID_TOKEN_CLAIMS);

      assert.calledOnce(mockVerify);
      assert.deepEqual(resp, MOCK_ID_TOKEN_CLAIMS);
      mockVerify.restore();
    });

    it('allows missing claims', async () => {
      delete MOCK_ID_TOKEN_CLAIMS.acr;

      const resp = await _testRequest(MOCK_ID_TOKEN_CLAIMS);

      assert.calledOnce(mockVerify);
      assert.deepEqual(resp, MOCK_ID_TOKEN_CLAIMS);
      mockVerify.restore();
    });
  });

  describe('/account/scoped-key-data', () => {
    it('calls oauthdb.getScopedKeyData', async () => {
      mockOAuthDB = mocks.mockOAuthDB({
        getScopedKeyData: sinon.spy(async () => {
          return { key: 'data' };
        }),
      });
      sessionToken = await mockSessionToken();
      const mockRequest = mocks.mockRequest({
        credentials: sessionToken,
        payload: {
          client_id: MOCK_CLIENT_ID,
          scope: MOCK_SCOPES,
        },
      });
      const resp = await loadAndCallRoute(
        '/account/scoped-key-data',
        mockRequest
      );
      assert.calledOnce(mockOAuthDB.getScopedKeyData);
      assert.calledWithExactly(mockOAuthDB.getScopedKeyData, sessionToken, {
        client_id: MOCK_CLIENT_ID,
        scope: MOCK_SCOPES,
      });
      assert.deepEqual(resp, { key: 'data' });
    });

    it('can refuse to return scoped-key data for selected OAuth clients', async () => {
      mockOAuthDB = mocks.mockOAuthDB();
      mockConfig.oauth.disableNewConnectionsForClients = [MOCK_CLIENT_ID];
      sessionToken = await mockSessionToken();
      const mockRequest = mocks.mockRequest({
        credentials: sessionToken,
        payload: {
          client_id: MOCK_CLIENT_ID,
          scope: MOCK_SCOPES,
        },
      });
      try {
        await loadAndCallRoute('/account/scoped-key-data', mockRequest);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.output.statusCode, 503);
        assert.equal(err.output.headers['retry-after'], '30');
        assert.equal(err.errno, error.ERRNO.DISABLED_CLIENT_ID);
      }
      assert.notCalled(mockOAuthDB.getScopedKeyData);
    });
  });

  describe('/oauth/authorization', () => {
    it('can refuse to authorize new grants for selected OAuth clients', async () => {
      mockConfig.oauth.disableNewConnectionsForClients = [MOCK_CLIENT_ID];
      sessionToken = await mockSessionToken();
      const mockRequest = mocks.mockRequest({
        credentials: sessionToken,
        payload: {
          client_id: MOCK_CLIENT_ID,
          scope: MOCK_SCOPES,
          state: 'xyz',
        },
      });
      try {
        await loadAndCallRoute('/oauth/authorization', mockRequest);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.output.statusCode, 503);
        assert.equal(err.errno, error.ERRNO.DISABLED_CLIENT_ID);
      }
    });
  });

  describe('/oauth/destroy', () => {
    it('errors if no client_id is provided', async () => {
      const mockRequest = mocks.mockRequest({
        payload: {
          token: MOCK_TOKEN,
        },
      });
      try {
        await loadAndCallRoute('/oauth/destroy', mockRequest);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.details[0].message, '"client_id" is required');
      }
    });

    it('does not try more token types if client credentials are invalid', async () => {
      const mockRequest = mocks.mockRequest({
        payload: {
          client_id: '0000000000000000',
          token: MOCK_TOKEN,
        },
      });
      try {
        await loadAndCallRoute('/oauth/destroy', mockRequest);
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.errno, error.ERRNO.UNKNOWN_CLIENT_ID);
      }
    });
  });
});
