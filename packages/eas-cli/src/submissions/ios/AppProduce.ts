import { App, RequestContext, Session, User } from '@expo/apple-utils';
import { getConfig } from '@expo/config';
import chalk from 'chalk';

import { authenticateAsync, getRequestContext } from '../../credentials/ios/appstore/authenticate';
import {
  ensureAppExistsAsync,
  ensureBundleIdExistsWithNameAsync,
} from '../../credentials/ios/appstore/ensureAppExists';
import Log from '../../log';
import { getBundleIdentifierAsync } from '../../project/ios/bundleIdentifier';
import { promptAsync } from '../../prompts';
import { IosSubmissionContext } from '../types';
import { sanitizeLanguage } from './utils/language';

interface CreateAppOptions {
  appleId?: string;
  appName: string;
  bundleIdentifier: string;
  appleTeamId?: string;
  itcTeamId?: string;
  language?: string;
  companyName?: string;
  sku?: string;
}

type AppStoreResult = {
  appleId: string;
  ascAppId: string;
};

export async function ensureAppStoreConnectAppExistsAsync(
  ctx: IosSubmissionContext
): Promise<AppStoreResult> {
  const projectConfig = getConfig(ctx.projectDir, { skipSDKVersionRequirement: true });
  const { exp } = projectConfig;

  const { bundleIdentifier, appName, language } = ctx.commandFlags;

  // TODO:
  // - for builds from the database, read bundled identifier from metadata
  // - for builds uploaded from file system, prompt for the bundle identifier
  // this is necessary to make submit work outside the project directory
  const resolvedBundleId =
    bundleIdentifier ?? (await getBundleIdentifierAsync(ctx.projectDir, exp));

  const options = {
    ...ctx.commandFlags,
    bundleIdentifier: resolvedBundleId,
    appName: appName ?? exp.name ?? (await promptForAppNameAsync()),
    language: sanitizeLanguage(language),
  };

  return await createAppStoreConnectAppAsync(options);
}

async function isProvisioningAvailableAsync(requestCtx: RequestContext): Promise<boolean> {
  const session = Session.getAnySessionInfo();
  // TODO: Investigate if username and email can be different
  const username = session?.user.emailAddress;
  const [user] = await User.getAsync(requestCtx, { query: { filter: { username } } });
  return user.attributes.provisioningAllowed;
}

async function createAppStoreConnectAppAsync(options: CreateAppOptions): Promise<AppStoreResult> {
  const {
    appleId,
    appleTeamId,
    bundleIdentifier: bundleId,
    appName,
    language,
    companyName,
  } = options;

  const authCtx = await authenticateAsync({
    appleId,
    teamId: appleTeamId,
  });
  const requestCtx = getRequestContext(authCtx);

  Log.addNewLineIfNone();

  if (await isProvisioningAvailableAsync(requestCtx)) {
    await ensureBundleIdExistsWithNameAsync(authCtx, {
      name: appName,
      bundleIdentifier: bundleId,
    });
  } else {
    Log.warn(
      `Provisioning is not available for user "${authCtx.appleId}", skipping bundle identifier check.`
    );
  }

  let app: App | null = null;

  try {
    app = await ensureAppExistsAsync(authCtx, {
      name: appName,
      language,
      companyName,
      bundleIdentifier: bundleId,
    });
  } catch (error) {
    if (
      // Name is invalid
      error.message.match(
        /App Name contains certain Unicode(.*)characters that are not permitted/
      ) ||
      // UnexpectedAppleResponse: An attribute value has invalid characters. - App Name contains certain Unicode symbols, emoticons, diacritics, special characters, or private use characters that are not permitted.
      // Name is taken
      error.message.match(/The App Name you entered is already being used/)
      // UnexpectedAppleResponse: The provided entity includes an attribute with a value that has already been used on a different account. - The App Name you entered is already being used. If you have trademark rights to
      // this name and would like it released for your use, submit a claim.
    ) {
      Log.addNewLineIfNone();
      Log.warn(
        `Change the name in your app config, or use a custom name with the ${chalk.bold(
          '--app-name'
        )} flag`
      );
      Log.newLine();
    }
    throw error;
  }

  return {
    appleId: authCtx.appleId,
    ascAppId: app.id,
  };
}

async function promptForAppNameAsync(): Promise<string> {
  const { appName } = await promptAsync({
    type: 'text',
    name: 'appName',
    message: 'What would you like to name your app?',
    validate: (val: string) => val !== '' || 'App name cannot be empty!',
  });
  return appName;
}
