# Drupal 10 to 11 upgrade: deploy runbook

Site: Acme D10 (bench run `run1`)
From: Drupal 10.2.7, Drush 12.4, CKEditor 4
To: Drupal 11.4.12, Drush 13.8, CKEditor 5

You merge and deploy, in two releases. Nothing here touches your production
site until you run it.

## Why two releases

Drupal 11 only updates databases that are already on Drupal 10.3 or later,
and CKEditor 4 has to be uninstalled while its code is still present. So:

| Release | Patches | Git tag in the delivery branch | What it does |
|---|---|---|---|
| 1 | 0001, 0002, 0003 | `phase1-d10` | Core 10.6, Drush 13, contrib on releases that support 10 and 11, Book and Forum from contrib, custom code on Drupal 11 APIs, text formats moved to CKEditor 5 and CKEditor 4 uninstalled (`drush updb` does this) |
| 2 | 0004 | `phase2-d11` | Core 11.4, CKEditor 4 code removed |

Deploy release 1, check it, and only then deploy release 2. They can go out
the same day.

Apply the patches with `git am patches/*.patch` on the branch you gave us,
or merge the pull request.

## Server requirements (release 2)

- PHP 8.3 or newer, with the usual Drupal extensions (gd, pdo + your DB driver, xml, mbstring, opcache).
- Database: MySQL 8.0, MariaDB 10.6, PostgreSQL 16, or SQLite 3.45 or newer.
- Composer 2.7 or newer.
- Drush 13 (installed by Composer with the site; use `vendor/bin/drush`).

Release 1 also needs PHP 8.3 (Drush 13 requires it), so upgrade PHP first if
the server is older. Drupal 10.6 runs on PHP 8.3.

## Before each release

1. Back up the database and the files directory. Keep them until you sign off.
   - MySQL/MariaDB: `vendor/bin/drush sql:dump --gzip --result-file=../backup-$(date +%F-%H%M).sql`
   - SQLite: copy the `.sqlite` file while the site is in maintenance mode.
2. Note the currently deployed git commit (`git rev-parse HEAD`). That is your code rollback point.
3. Optional: `vendor/bin/drush state:set system.maintenance_mode 1 --input-format=integer`

## Deploy (same commands for both releases)

```sh
git checkout <release tag or merge commit>
composer install --no-dev --optimize-autoloader
vendor/bin/drush updatedb -y
vendor/bin/drush cache:rebuild
# If you keep configuration in code, export once after release 1 and commit it:
#   vendor/bin/drush config:export -y
vendor/bin/drush state:set system.maintenance_mode 0 --input-format=integer
```

Run `updatedb` before `cache:rebuild`. On release 2, a cache rebuild before
the updates fails with `table router has no column named alias`, because
Drupal 11.4 adds that column in an update. It's harmless if it happens: run
`updatedb`, then `cache:rebuild`.

If you use `drush deploy`, that runs updatedb, config import, cache rebuild
and deploy hooks in the right order. **Release 1 warning:** if you use config
import, export your config after release 1 first. Release 1 moves the text
formats to CKEditor 5 and uninstalls CKEditor 4 in the database. Importing an
older export would try to turn CKEditor 4 back on.

## Checks after each release

```sh
vendor/bin/drush status          # Drupal version: 10.6.x after release 1, 11.4.x after release 2. Bootstrap: Successful
vendor/bin/drush updatedb:status # "No database updates required."
vendor/bin/drush core:requirements --severity=2   # no new errors
vendor/bin/drush watchdog:show --severity=Error --count=20
```

In a browser:
- The front page, `/user/login`, a content page, `/forum`, `/book` return 200.
- Edit a node that uses each text format (Basic HTML, Full HTML, Legacy HTML)
  and check the editor shows CKEditor 5 and saving works.
- Submit a test webform.

After release 1 only:
- `vendor/bin/drush pm:list --status=enabled --filter=ckeditor` lists only `ckeditor5`.
- `vendor/bin/drush watchdog:show --type=acme_tools` shows what the CKEditor
  migration did. On the bench copy, the **Legacy HTML** format lost its image
  button because that format's allowed HTML never included `<img>`, so
  images were already stripped on output. If you want images there, add
  `<img src alt height width>` to the format's allowed HTML and re-add the
  button.

## Rollback

Release 1 and release 2 both change the database, so a code rollback alone
is not enough. Roll back code and database together:

```sh
vendor/bin/drush state:set system.maintenance_mode 1 --input-format=integer
git checkout <commit you noted before the release>
composer install --no-dev --optimize-autoloader
# restore the database backup taken before this release, e.g.
#   gunzip -c ../backup-....sql.gz | vendor/bin/drush sql:cli
vendor/bin/drush cache:rebuild
vendor/bin/drush state:set system.maintenance_mode 0 --input-format=integer
```

- Rolling back release 2 returns you to release 1 (Drupal 10.6), which is a
  supported, working state. We tested this: the release 1 code with the
  pre-release-2 database boots, has no pending updates, and serves 200s
  (`rollback-drill.log`).
- Don't run Drupal 10 code against a database that Drupal 11 has updated.
  Always restore the backup.
- Content created between the release and the rollback is lost with the
  restore. Keep the window short, or use maintenance mode.

## What we checked (bench run evidence)

| Check | Result | File |
|---|---|---|
| Composer resolves on Drupal 11 (PHP 8.3) | pass, `composer validate` OK | `commands.log`, `final-verification-d11.log` |
| Upgrade Status on Drupal 10.6, custom code, Drupal 11 readiness | 0 deprecations, 0 info.yml problems; 2 "check manually" items that already existed (see below) | `upgrade-status-custom-d10.6.txt` |
| PHPStan level 0 + phpstan-drupal + deprecation rules on custom code (Drupal 10.6) | before: 4 deprecated calls + 2 pre-existing errors; after: 0 deprecated calls + the same 2 pre-existing errors | `phpstan-custom-before-d10.6.txt`, `phpstan-custom-after-d10.6.txt` |
| Same PHPStan on Drupal 11.4 | 0 deprecations; same 2 pre-existing errors | `phpstan-custom-after-d11.4.log` |
| Release 1 `drush updb` from the original 10.2.7 database | pass | `phase1-updb.log` |
| Release 2 `drush updb`, `cr`, `status` | pass, "No database updates required", no pending entity schema updates | `phase2-updb.log`, `final-verification-d11.log` |
| HTTP 200 on /, /user/login, /node/1, /node/2, /forum, /book (php -S in the container) | pass | `final-verification-d11.log` |
| Rollback from release 2 to release 1 | pass | `rollback-drill.log` |
| Your automated tests | none found in the repository | none |

## Problems found in your code that the upgrade did not cause

These were in `acme_tools.module` before the upgrade and are still there. We
didn't change them because we can't tell what the code is meant to do:

1. `foo()` is called in `acme_tools_cron()` but is not defined anywhere.
   This throws `\Error`, which `catch (\Exception)` doesn't catch, so **every
   cron run dies at this line**, on Drupal 10 as well as 11
   (`phase2-checks.log`). Remove the call or define the function.
2. `acme_tools.batch.inc` is included in cron but doesn't exist. The include
   does nothing, silently.

Also:
- `acme_theme` declared `base theme: classy`. Classy left core in Drupal
  10.0, so the theme couldn't be installed even on the original site. It now
  uses `stable9`, which is in core for 10 and 11. The theme has no templates
  or CSS, so nothing depended on Classy's markup. We installed it on Drupal 11
  and it serves 200s. If you want Classy's markup, `composer require
  drupal/classy` and switch the base theme back.
- The "Trusted Host Settings: Not enabled" requirement error was there before
  the upgrade. Set `$settings['trusted_host_patterns']` in `settings.php`.
- Drupal 11 reports the Contact module as deprecated. It still works in
  Drupal 11 and is a Drupal 12 matter.
