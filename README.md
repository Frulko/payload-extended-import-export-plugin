# Payload Extended Import Export Plugin

An extended import and export plugin for [Payload CMS](https://payloadcms.com) with additional features and enhancements.

## Features

- 📤 **Data Import** - Import data from CSV, JSON and other formats
- 🔧 **Field Mapping Configuration** - Flexible field mapping during import  
- 📊 **Data Preview** - Preview data before importing
- ⚡ **Import Progress** - Track import progress in real-time
- 🎯 **Selective Import** - Choose specific collections to import
- 🌐 **Localization Support** - Work with multilingual data
- 🔍 **Data Validation** - Validate data before import
- 📁 **Sample Files** - Generate sample files for import
- 🗒️ **Notion Import** - Import a Notion export (ZIP) with its page content and images

## Installation

Install the plugin via npm or pnpm:

```bash
npm i payload-extended-import-export-plugin
```

or

```bash
pnpm add payload-extended-import-export-plugin
```

## Usage

Add the plugin to your `payload.config.ts`:

```ts
import { payloadExtendedImportExportPlugin } from 'payload-extended-import-export-plugin'

export default buildConfig({
  plugins: [
    payloadExtendedImportExportPlugin({
      collections: ['posts', 'users', 'pages'], // Specify collections for import
      enabled: true,
    }),
  ],
})
```

## Configuration Options

The plugin accepts the following configuration options:

### `collections` (required)
- **Type**: `CollectionSlug[]`
- **Description**: Array of collection slugs where the import functionality should be enabled

### `enabled` (optional)
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Enable or disable the plugin functionality

```ts
payloadExtendedImportExportPlugin({
  collections: ['posts', 'users', 'pages'], // Enable import for these collections
  enabled: process.env.NODE_ENV !== 'production', // Disable in production
})
```

## How It Works

1. **Upload File**: Select and upload your data file (CSV, JSON, etc.)
2. **Preview Data**: Review the parsed data before importing
3. **Configure Mapping**: Map your file columns to collection fields
4. **Validate**: Check for any data validation errors
5. **Import**: Execute the import with real-time progress tracking

## Supported File Formats

- **CSV** - Comma-separated values (RFC 4180: quotes, commas and line breaks inside values)
- **JSON** - JavaScript Object Notation
- **Excel** - .xlsx files
- **ZIP** - Notion export (Markdown & CSV), images included

## Notion Import

Drop a Notion export archive straight into the drawer — no unzipping, no manual image upload.

1. In Notion: **••• → Export → Markdown & CSV**, include subpages, download the `.zip`
2. Drop the `.zip` into the import drawer
3. Map the columns and import

What the plugin does with the archive:

- Reads the database CSV (the first one found) as the rows to import
- Adds a **`content`** column holding the page body (Markdown, without the title and the
  property block). Map it to a `richText` or `textarea` field
- Uploads the files referenced by *Files & media* columns **and** the images embedded in page
  bodies into your upload collection (`media`, or the first upload-enabled collection), then
  links them: upload fields get the document ID, `richText` fields get a real Lexical upload node
- Only the files actually referenced by the imported rows are sent to the server

Known limits:

- The archive is parsed in the browser and its files travel to the server inside a single JSON
  request — good for regular exports, not for multi-gigabyte ones
- Identical files are deduplicated within one import; re-importing the same archive creates new
  `media` documents
- ZIP64 archives (>4 GB or >65535 files) are not supported

## User Interface

The plugin adds an "Import" button to the list view of enabled collections. Clicking this button opens a drawer with the import interface that guides you through the import process:

- **File Upload**: Drag and drop or select files
- **Data Preview**: Table view of your data
- **Field Mapping**: Visual mapping interface
- **Progress Tracking**: Real-time import status
- **Error Handling**: Clear error messages and validation

## Development

This plugin is built with:

- **TypeScript** - Type-safe development
- **React** - Modern UI components
- **Payload CMS** - Integrated with Payload's admin interface
- **File Processing** - Support for multiple file formats

### Development Setup

To set up the development environment:

```bash
# Clone the repository
git clone https://github.com/saroroce/payload-extended-import-export-plugin

# Install dependencies
pnpm install

# Set up environment variables
cd dev
cp .env.example .env
```

**Environment Configuration:**

Create a `.env` file in the `dev` folder with the following variables:

```env
# Database connection string
DATABASE_URI="mongodb://localhost:27017/payload-import-export-dev"

# Payload secret for JWT tokens
PAYLOAD_SECRET="your-secret-key-here"

# Optional: Email configuration for testing
EMAIL_FROM="test@example.com"
EMAIL_FROM_NAME="Payload Import Export Plugin"
```

**Important Notes:**
- Update `DATABASE_URI` to match your database setup (MongoDB, PostgreSQL, etc.)
- Generate a secure random string for `PAYLOAD_SECRET`
- The plugin has been pre-configured in `dev/payload.config.ts`

```bash
# Start development server
pnpm dev
```

The development server will be available at [http://localhost:3000](http://localhost:3000).

## Examples

### Basic Import Configuration

```ts
// payload.config.ts
import { payloadExtendedImportExportPlugin } from 'payload-extended-import-export-plugin'

export default buildConfig({
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'content', type: 'textarea' },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
      ],
    },
  ],
  plugins: [
    payloadExtendedImportExportPlugin({
      collections: ['posts'], // Enable import for posts collection
      enabled: true,
    }),
  ],
})
```

### Advanced Configuration

```ts
payloadExtendedImportExportPlugin({
  collections: ['posts', 'users', 'pages'],
  enabled: process.env.NODE_ENV !== 'production', // Disable in production
})
```

### Sample CSV Format

For a `posts` collection, your CSV might look like:

```csv
title,content,status
"My First Post","This is the content of my first post",published
"Draft Post","This is a draft post",draft
"Another Post","More content here",published
```

## Testing

The plugin includes comprehensive tests to ensure reliability:

```bash
# Run integration tests
pnpm test:int

# Run end-to-end tests  
pnpm test:e2e

# Run all tests
pnpm test
```

## API Reference

### Plugin Configuration

```ts
interface PayloadExtendedImportExportPluginConfig {
  collections: CollectionSlug[]  // Required: Array of collection slugs
  enabled?: boolean              // Optional: Enable/disable plugin (default: true)
}
```

### Import Endpoint

The plugin exposes an import endpoint at `/api/import` that accepts:

- **Method**: `POST`
- **Content-Type**: `multipart/form-data`
- **Body**: Form data with file and configuration

## Troubleshooting

### Common Issues

**Import button not visible:**
- Ensure the collection slug is included in the `collections` array
- Check that the plugin is properly configured in `payload.config.ts`

**File upload errors:**
- Verify file format is supported (CSV, JSON, Excel, ZIP)
- Check file size limits in your Payload configuration
- Ensure proper field mapping between file columns and collection fields

**Notion images are missing:**
- Export from Notion as **Markdown & CSV** (the HTML export is not supported)
- Import the `.zip` as downloaded — images are resolved by their path inside the archive
- Make sure the target field is an `upload` field, or a `richText` field for page bodies

**Import validation errors:**
- Review required fields in your collection schema
- Check data types match between import data and field definitions
- Verify any custom validation rules are met

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Guidelines

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions, please:

1. Check the [GitHub Issues](https://github.com/saroroce/payload-extended-import-export-plugin/issues)
2. Create a new issue if needed
3. Contact the maintainer: [saroroce](https://github.com/saroroce)

## Related

- [Payload CMS](https://payloadcms.com) - The headless CMS this plugin extends
- [Payload Plugins](https://payloadcms.com/docs/plugins/overview) - Official plugin documentation
