import { Profile, ProfileType, RequestContext } from '@expo/apple-utils';
import ora from 'ora';

import { findP12CertSerialNumber } from '../utils/p12Certificate';
import {
  DistributionCertificate,
  ProvisioningProfile,
  ProvisioningProfileStoreInfo,
} from './Credentials.types';
import { AuthCtx, getRequestContext } from './authenticate';
import { getBundleIdForIdentifierAsync, getProfilesForBundleIdAsync } from './bundleId';
import { getCertificateBySerialNumberAsync, transformCertificate } from './distributionCertificate';
import { USE_APPLE_UTILS } from './experimental';
import { runActionAsync, travelingFastlane } from './fastlane';

export enum ProfileClass {
  Adhoc = 'ad_hoc',
  General = 'general',
}

enum TravelingFastlaneProfileType {
  AppStoreAdhoc = 'app_store_adhoc',
  AppStoreDist = 'app_store_dist',
  InHouseAdhoc = 'in_house_adhoc',
  InHouseDist = 'in_house_dist',
}

function resolveTravelingFastlaneProfileType(
  profileClass: ProfileClass,
  isEnterprise?: boolean
): TravelingFastlaneProfileType {
  if (isEnterprise) {
    return profileClass === ProfileClass.Adhoc
      ? TravelingFastlaneProfileType.InHouseAdhoc
      : TravelingFastlaneProfileType.InHouseDist;
  } else {
    return profileClass === ProfileClass.Adhoc
      ? TravelingFastlaneProfileType.AppStoreAdhoc
      : TravelingFastlaneProfileType.AppStoreDist;
  }
}

function resolveProfileType(profileClass: ProfileClass, isEnterprise?: boolean): ProfileType {
  if (isEnterprise) {
    return profileClass === ProfileClass.Adhoc
      ? ProfileType.IOS_APP_ADHOC
      : ProfileType.IOS_APP_INHOUSE;
  } else {
    return profileClass === ProfileClass.Adhoc
      ? ProfileType.IOS_APP_ADHOC
      : ProfileType.IOS_APP_STORE;
  }
}

async function transformProfileAsync(
  cert: Profile,
  authCtx: AuthCtx
): Promise<ProvisioningProfileStoreInfo> {
  return {
    provisioningProfileId: cert.id,
    name: cert.attributes.name,
    status: cert.attributes.profileState,
    expires: new Date(cert.attributes.expirationDate).getTime() / 1000,
    distributionMethod: cert.attributes.profileType,
    // @ts-ignore -- this can be null when the profile has expired.
    provisioningProfile: cert.attributes.profileContent,
    certificates: (await cert.getCertificatesAsync()).map(transformCertificate),
    teamId: authCtx.team.id,
    teamName: authCtx.team.name,
  };
}

async function addCertificateToProfileAsync(
  context: RequestContext,
  {
    serialNumber,
    profileId,
    bundleIdentifier,
  }: {
    serialNumber: string;
    profileId: string;
    bundleIdentifier: string;
  }
) {
  const cert = await getCertificateBySerialNumberAsync(context, serialNumber);

  const profiles = await getProfilesForBundleIdAsync(context, bundleIdentifier);
  const profile = profiles.find(profile => profile.id === profileId);
  if (!profile) {
    throw new Error(
      `Failed to find profile for bundle identifier "${bundleIdentifier}" with profile id "${profileId}"`
    );
  }

  // Assign the new certificate
  profile.attributes.certificates = [cert];
  return await profile.regenerateAsync();
}

export async function useExistingProvisioningProfileAsync(
  authCtx: AuthCtx,
  bundleIdentifier: string,
  provisioningProfile: ProvisioningProfile,
  distCert: DistributionCertificate,
  profileClass: ProfileClass = ProfileClass.General
): Promise<ProvisioningProfile> {
  const spinner = ora(`Configuring existing Provisioning Profiles from Apple...`).start();
  try {
    if (!provisioningProfile.provisioningProfileId) {
      throw new Error('Provisioning profile: cannot use existing profile, insufficient id');
    }

    if (!distCert.distCertSerialNumber) {
      distCert.distCertSerialNumber = findP12CertSerialNumber(
        distCert.certP12,
        distCert.certPassword
      );
    }

    let result: ProvisioningProfile;

    if (USE_APPLE_UTILS) {
      const context = getRequestContext(authCtx);
      const profile = await addCertificateToProfileAsync(context, {
        serialNumber: distCert.distCertSerialNumber,
        profileId: provisioningProfile.provisioningProfileId,
        bundleIdentifier,
      });
      const content = profile.attributes.profileContent;
      if (!content) {
        // this should never happen because of the regen.
        throw new Error(
          `Provisioning profile "${profile.attributes.name}" (${profile.id}) is expired!`
        );
      }
      result = {
        provisioningProfileId: profile.id,
        provisioningProfile: content,
        teamId: authCtx.team.id,
        teamName: authCtx.team.name,
      };
    } else {
      const args = [
        'use-existing',
        authCtx.appleId,
        authCtx.appleIdPassword,
        authCtx.team.id,
        resolveTravelingFastlaneProfileType(profileClass, authCtx.team.inHouse),
        bundleIdentifier,
        provisioningProfile.provisioningProfileId,
        distCert.distCertSerialNumber,
      ];
      result = await runActionAsync(travelingFastlane.newManageProvisioningProfiles, args);
    }
    spinner.succeed();
    return {
      ...result,
      teamId: authCtx.team.id,
      teamName: authCtx.team.name,
    };
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

export async function listProvisioningProfilesAsync(
  authCtx: AuthCtx,
  bundleIdentifier: string,
  profileClass: ProfileClass = ProfileClass.General
): Promise<ProvisioningProfileStoreInfo[]> {
  const spinner = ora(`Getting Provisioning Profiles from Apple...`).start();
  try {
    if (USE_APPLE_UTILS) {
      const context = getRequestContext(authCtx);
      const profileType = resolveProfileType(profileClass, authCtx.team.inHouse);
      const profiles = (await getProfilesForBundleIdAsync(context, bundleIdentifier)).filter(
        profile => profile.attributes.profileType === profileType
      );

      const result = await Promise.all(
        profiles.map(profile => transformProfileAsync(profile, authCtx))
      );
      spinner.succeed();
      return result;
    } else {
      const args = [
        'list',
        authCtx.appleId,
        authCtx.appleIdPassword,
        authCtx.team.id,
        resolveTravelingFastlaneProfileType(profileClass, authCtx.team.inHouse),
        bundleIdentifier,
      ];
      const { profiles } = await runActionAsync(
        travelingFastlane.newManageProvisioningProfiles,
        args
      );
      spinner.succeed();
      return profiles.map((profile: Omit<ProvisioningProfileStoreInfo, 'teamId' | 'teamName'>) => ({
        ...profile,
        teamId: authCtx.team.id,
        teamName: authCtx.team.name,
      }));
    }
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

export async function createProvisioningProfileAsync(
  authCtx: AuthCtx,
  bundleIdentifier: string,
  distCert: DistributionCertificate,
  profileName: string,
  profileClass: ProfileClass = ProfileClass.General
): Promise<ProvisioningProfile> {
  const spinner = ora(`Creating Provisioning Profile on Apple Servers...`).start();
  try {
    if (!distCert.distCertSerialNumber) {
      distCert.distCertSerialNumber = findP12CertSerialNumber(
        distCert.certP12,
        distCert.certPassword
      );
    }

    if (USE_APPLE_UTILS) {
      const context = getRequestContext(authCtx);
      const profileType = resolveProfileType(profileClass, authCtx.team.inHouse);

      const certificate = await getCertificateBySerialNumberAsync(
        context,
        distCert.distCertSerialNumber
      );

      const bundleIdItem = await getBundleIdForIdentifierAsync(context, bundleIdentifier);

      const profile = await Profile.createAsync(context, {
        bundleId: bundleIdItem.id,
        name: profileName,
        certificates: [certificate.id],
        devices: [],
        profileType,
      });

      const result = await transformProfileAsync(profile, authCtx);
      spinner.succeed();
      return result;
    } else {
      const args = [
        'create',
        authCtx.appleId,
        authCtx.appleIdPassword,
        authCtx.team.id,
        resolveTravelingFastlaneProfileType(profileClass, authCtx.team.inHouse),
        bundleIdentifier,
        distCert.distCertSerialNumber,
        profileName,
      ];
      const result = await runActionAsync(travelingFastlane.newManageProvisioningProfiles, args);
      spinner.succeed();
      return {
        ...result,
        teamId: authCtx.team.id,
        teamName: authCtx.team.name,
      };
    }
  } catch (error) {
    spinner.fail('Failed to create Provisioning Profile on Apple Servers');
    throw error;
  }
}

export async function revokeProvisioningProfileAsync(
  authCtx: AuthCtx,
  bundleIdentifier: string,
  profileClass: ProfileClass = ProfileClass.General
): Promise<void> {
  const spinner = ora(`Revoking Provisioning Profile on Apple Servers...`).start();
  try {
    if (USE_APPLE_UTILS) {
      const context = getRequestContext(authCtx);

      const profiles = await getProfilesForBundleIdAsync(context, bundleIdentifier);
      const profileType = resolveProfileType(profileClass, authCtx.team.inHouse);
      await Promise.all(
        profiles
          .filter(profile => profile.attributes.profileType === profileType)
          .map(profile => Profile.deleteAsync(context, { id: profile.id }))
      );
    } else {
      const args = [
        'revoke',
        authCtx.appleId,
        authCtx.appleIdPassword,
        authCtx.team.id,
        resolveTravelingFastlaneProfileType(profileClass, authCtx.team.inHouse),
        bundleIdentifier,
      ];
      await runActionAsync(travelingFastlane.newManageProvisioningProfiles, args);
    }

    spinner.succeed();
  } catch (error) {
    spinner.fail('Failed to revoke Provisioning Profile on Apple Servers');
    throw error;
  }
}
