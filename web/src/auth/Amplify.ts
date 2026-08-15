import { Amplify } from 'aws-amplify';
import type { BbgConfig } from '../config';

export const configureAmplify = (cfg: BbgConfig): void => {
  if (!cfg.userPoolId || !cfg.userPoolClientId) {
    // Allow the app to render in unconfigured local dev so devs can iterate
    // on the layout without a fully-deployed Cognito User Pool.
    return;
  }
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cfg.userPoolId,
        userPoolClientId: cfg.userPoolClientId,
        loginWith: {
          oauth: {
            domain: `${cfg.userPoolDomain}.auth.${cfg.region}.amazoncognito.com`,
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn: [`${window.location.origin}/callback`],
            redirectSignOut: [window.location.origin],
            responseType: 'code',
          },
        },
      },
    },
  });
};
