<?php
// Heading
$_['heading_title']    = 'Elyon CRM Bridge';

// Text
$_['text_extension']   = 'Extensions';
$_['text_success']     = 'Success: Elyon CRM Bridge settings saved.';
$_['text_edit']        = 'Elyon CRM Bridge';
$_['text_home']        = 'Dashboard';
$_['text_enabled']     = 'Enabled';
$_['text_disabled']    = 'Disabled';
$_['text_general']     = 'Settings';
$_['text_import']      = 'Historical import';
$_['text_importing']   = 'Importing… this can take a while for many orders.';
$_['text_test_run']    = 'Testing…';

// Entry
$_['entry_status']     = 'Live sync';
$_['entry_url']        = 'CRM webhook URL';
$_['entry_secret']     = 'Shared secret';
$_['entry_source']     = 'Source label';
$_['entry_statuses']   = 'Send these order statuses';
$_['entry_abandoned']  = 'Capture abandoned carts';
$_['entry_import_since'] = 'Import orders from (date)';

// Help
$_['help_url']         = 'Paste your CRM endpoint, e.g. https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/api/webhook/opencart';
$_['help_secret']      = 'Must match the WEBHOOK_SECRET set on the CRM edge function. Never shared with the browser/customer.';
$_['help_source']      = 'Shown in the CRM so you know where the pending came from. Default: naturatherapy.bg';
$_['help_statuses']    = 'Only orders that reach one of these statuses are pushed as Pendings. Default: Pending.';
$_['help_abandoned']   = 'Also push incomplete checkouts to the CRM as leads — but only when they have a full name (first + last) and a complete phone number.';
$_['help_import']      = 'One-time backfill. Pushes existing orders (in the selected statuses) placed on/after this date. Safe to re-run — duplicates are de-duped in the CRM. Default is the 1st of the current month.';

// Button
$_['button_save']      = 'Save';
$_['button_cancel']    = 'Back';
$_['button_test']      = 'Test connection';
$_['button_import']    = 'Run import now';

// Error
$_['error_permission'] = 'Warning: You do not have permission to modify the Elyon CRM Bridge.';
$_['error_url']        = 'CRM webhook URL is required when live sync is enabled.';
