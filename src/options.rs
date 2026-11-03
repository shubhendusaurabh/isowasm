//! Image options as passed from JavaScript, and their mapping to hadris-iso.

use std::num::NonZeroU16;

use hadris_iso::boot::options::{BootEntryOptions, BootOptions, BootSectionOptions};
use hadris_iso::boot::{EmulationType, PlatformId};
use hadris_iso::joliet::JolietLevel;
use hadris_iso::read::PathSeparator;
use hadris_iso::rrip::RripOptions;
use hadris_iso::write::options::{BaseIsoLevel, CreationFeatures, IsoFormatOptions};
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// Volume label. Sanitised to `A-Z 0-9 _`, max 32 chars. Default "CDROM".
    pub volume_name: Option<String>,
    /// Joliet tree: Unicode names up to 64 chars, used by Windows. Default true.
    pub joliet: Option<bool>,
    /// Rock Ridge: POSIX names, permissions, timestamps and deep folders. Default true.
    pub rock_ridge: Option<bool>,
    /// Base ISO 9660 interchange level, 1-3. Default 1 (most compatible).
    pub iso_level: Option<u8>,
    /// Also write an ISO 9660:1999 tree with names up to 207 chars.
    pub long_filenames: bool,
    pub system_id: Option<String>,
    pub volume_set_id: Option<String>,
    pub publisher_id: Option<String>,
    pub preparer_id: Option<String>,
    pub application_id: Option<String>,
    /// El Torito boot entries.
    pub boot: Option<BootConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootConfig {
    /// Path inside the image of the BIOS boot image, e.g. "isolinux/isolinux.bin".
    pub bios_image: Option<String>,
    /// "none" (default), "floppy1.2", "floppy1.44", "floppy2.88" or "hdd".
    pub emulation: Option<String>,
    /// 512-byte sectors loaded by the firmware. Default 4 for no emulation.
    pub load_size: Option<u16>,
    /// Patch a boot info table into the BIOS image (isolinux needs this).
    #[serde(default)]
    pub boot_info_table: bool,
    /// Patch GRUB2 boot info into the BIOS image.
    #[serde(default)]
    pub grub2_boot_info: bool,
    /// Path inside the image of a UEFI boot image (a FAT image, e.g. "efiboot.img").
    pub uefi_image: Option<String>,
}

/// Accepted keys, checked explicitly because serde-wasm-bindgen ignores unknown ones.
pub const OPTION_KEYS: &[&str] = &[
    "volumeName", "joliet", "rockRidge", "isoLevel", "longFilenames", "systemId",
    "volumeSetId", "publisherId", "preparerId", "applicationId", "boot",
];
pub const BOOT_KEYS: &[&str] = &[
    "biosImage", "emulation", "loadSize", "bootInfoTable", "grub2BootInfo", "uefiImage",
];

/// Turns any label into a valid ISO 9660 volume identifier (d-characters, <= 32).
pub fn volume_label(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        let c = c.to_ascii_uppercase();
        let c = if c.is_ascii_uppercase() || c.is_ascii_digit() { c } else { '_' };
        if !(c == '_' && (out.is_empty() || out.ends_with('_'))) {
            out.push(c);
        }
    }
    let out: String = out.chars().take(32).collect();
    let out = out.trim_end_matches('_');
    if out.is_empty() { "CDROM".into() } else { out.into() }
}

impl Options {
    pub fn into_format(self) -> Result<IsoFormatOptions, String> {
        let rock_ridge = self.rock_ridge.unwrap_or(true);
        let joliet = self.joliet.unwrap_or(true);
        let filenames = match self.iso_level.unwrap_or(1) {
            1 => BaseIsoLevel::Level1 { supports_lowercase: false, supports_rrip: rock_ridge },
            2 => BaseIsoLevel::Level2 { supports_lowercase: false, supports_rrip: rock_ridge },
            3 => BaseIsoLevel::Level3 { supports_lowercase: false, supports_rrip: rock_ridge },
            n => return Err(format!("isoLevel must be 1, 2 or 3 (got {n})")),
        };
        let el_torito = match self.boot {
            Some(boot) => boot.into_boot_options()?,
            None => None,
        };

        Ok(IsoFormatOptions {
            volume_name: volume_label(self.volume_name.as_deref().unwrap_or("CDROM")),
            system_id: self.system_id,
            volume_set_id: self.volume_set_id,
            publisher_id: self.publisher_id,
            preparer_id: self.preparer_id,
            application_id: self.application_id.or_else(|| Some("ISOWASM".into())),
            sector_size: 2048,
            path_separator: PathSeparator::ForwardSlash,
            strict_charset: false,
            features: CreationFeatures {
                filenames,
                long_filenames: self.long_filenames,
                joliet: joliet.then_some(JolietLevel::Level3),
                rock_ridge: rock_ridge.then(RripOptions::default),
                el_torito,
                hybrid_boot: None,
            },
        })
    }
}

impl BootConfig {
    fn into_boot_options(self) -> Result<Option<BootOptions>, String> {
        let emulation = match self.emulation.as_deref().unwrap_or("none") {
            "none" => EmulationType::NoEmulation,
            "floppy1.2" => EmulationType::Floppy1_2,
            "floppy1.44" => EmulationType::Floppy1_44,
            "floppy2.88" => EmulationType::Floppy2_88,
            "hdd" => EmulationType::HardDisk,
            other => return Err(format!("unknown boot emulation {other:?}")),
        };
        let load_size = match (self.load_size, &emulation) {
            (Some(n), _) => NonZeroU16::new(n),
            (None, EmulationType::NoEmulation) => NonZeroU16::new(4),
            (None, _) => None,
        };
        let path = |p: String| p.trim_matches('/').to_string();

        let bios = self.bios_image.map(|p| BootEntryOptions {
            boot_image_path: path(p),
            load_size,
            boot_info_table: self.boot_info_table,
            grub2_boot_info: self.grub2_boot_info,
            emulation,
        });
        let uefi = self.uefi_image.map(|p| BootEntryOptions {
            boot_image_path: path(p),
            emulation: EmulationType::NoEmulation,
            ..Default::default()
        });

        Ok(match (bios, uefi) {
            (None, None) => None,
            (Some(bios), uefi) => Some(BootOptions {
                write_boot_catalog: true,
                default: bios,
                entries: uefi
                    .map(|u| (BootSectionOptions { platform: PlatformId::UEFI }, u))
                    .into_iter()
                    .collect(),
            }),
            // UEFI only: the UEFI image is the default entry.
            (None, Some(uefi)) => Some(BootOptions {
                write_boot_catalog: true,
                default: uefi,
                entries: vec![],
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::volume_label;

    #[test]
    fn volume_labels() {
        assert_eq!(volume_label("My Photos 2024"), "MY_PHOTOS_2024");
        assert_eq!(volume_label("  --weird!!name--  "), "WEIRD_NAME");
        assert_eq!(volume_label("日本語"), "CDROM");
        assert_eq!(volume_label(""), "CDROM");
        assert_eq!(volume_label(&"a".repeat(40)).len(), 32);
    }
}
