# Payload Extended Import Export Plugin

An extended import and export plugin for [Payload CMS](https://payloadcms.com) with additional features and enhancements.

## Features

- 📤 **Data Import** - Import data from CSV, JSON, XLSX and Notion archives
- 🔧 **Field Mapping Configuration** - Flexible field mapping during import  
- 📊 **Data Preview** - Preview data before importing
- ⚡ **Import Progress** - Track import progress in real-time
- 🎯 **Selective Import** - Choose specific collections to import
- 🌐 **Localization Support** - Work with multilingual data
- 🔍 **Data Validation** - Validate data before import
- 📁 **Sample Files** - Generate sample files for import
- 🗒️ **Notion Import** - Import a Notion export (ZIP) with its page content and images
- 🖼️ **Image Upload** - Remote URLs and archive files are uploaded into your media collection

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

1. **Upload File**: select or drop your file (CSV, JSON, XLSX, or a Notion `.zip`)
2. **Preview Data**: the file is parsed **in the browser** into a table you can review
3. **Configure Mapping**: map each column to a collection field, pick the import mode and locale
4. **Import**: the rows are POSTed to `/api/import`, which converts each value to the target
   field type, uploads the images and writes the documents
5. **Report**: created/updated counts and per-row errors are shown in the drawer

### On the server

For every row, the endpoint looks up the target field in your collection schema and converts
the value accordingly:

| Field type | What the importer does |
| --- | --- |
| `text`, `textarea`, `email`, `date`… | value is used as-is |
| `number` | extracts a number from the string (a few "in stock"/"out of stock" keywords map to `1`/`0`) |
| `richText` | converts the text to Lexical; a line that only holds a Markdown image becomes an upload node |
| `upload` | value is an image URL (downloaded) or a file inside the imported archive; the created media document is linked. Comma-separated values for `hasMany` |
| `relationship` | value is a document ID; comma-separated IDs for `hasMany` |
| `array` | a JSON string is parsed, missing item IDs are generated |
| required fields with a `defaultValue` | filled in on create when the column is not mapped |

Import modes:

- **create** — always creates a new document, any mapped `id` is ignored
- **update** — finds the existing document through the *compare field* and merges the new values
  into it (so unmapped required fields keep their value)
- **upsert** — updates when the compare field matches, creates otherwise

## Supported File Formats

- **CSV** — comma-separated values, parsed per RFC 4180: quoted values, commas and line breaks
  inside a value, doubled quotes, and a leading BOM (the one Notion and Excel write) are handled.
  Columns with an empty header are dropped
- **JSON** — an array of objects; the keys of the first object become the columns
- **XLSX / XLS** — the first sheet, first row as the header (the parser is loaded on demand)
- **ZIP** — a Notion export (Markdown & CSV), images included — see below

## Notion Import

Drop a Notion export archive straight into the drawer — no unzipping, no manual image upload.

1. In Notion: **••• → Export → Markdown & CSV**, include subpages, download the `.zip`
2. Drop the `.zip` into the import drawer
3. Map the columns and import

### What is inside the archive

```
Export-1a2b3c.zip
├── Tasks 1a2b3c.csv                        ← the database rows
└── Tasks 1a2b3c/
    ├── Write the docs 4d5e6f.md            ← one page body per row
    └── Write the docs 4d5e6f/
        ├── cover.png                       ← files of the "Files & media" column
        └── diagram.png                     ← images used inside the page
```

```csv
Name,Status,Cover
Write the docs,In progress,Write%20the%20docs%204d5e6f/cover.png
```

### What the plugin makes of it

| Column | Value in the preview |
| --- | --- |
| `Name` | `Write the docs` |
| `Status` | `In progress` |
| `Cover` | `Tasks 1a2b3c/Write the docs 4d5e6f/cover.png` |
| `content` | the page body, with `![](Tasks 1a2b3c/Write the docs 4d5e6f/diagram.png)` |

Step by step:

- The **first CSV** of the archive gives the rows. Notion also writes an `..._all.csv` for
  databases with sub-items; the shorter, view-level CSV is the one used
- A **`content` column** is appended with the body of the matching `.md` page — its `# Title`
  heading and the property block right below it are stripped (the column is named
  `notion_content` if your database already has a `content` column). Pages are matched to rows
  by title (the page `# Title` against the first CSV column), so renamed or duplicated titles
  simply end up without content
- Every **file reference** — in a *Files & media* column or in a Markdown image of the body — is
  rewritten to its path inside the archive, whether it is written as a bare file name, a relative
  path or a URL-encoded one. External `https://` links are left untouched and downloaded by the
  server as usual
- Only the files **actually referenced** by the rows are carried over to the server, as data URIs
  in the import request
- Large exports that Notion delivers as an archive containing a single inner archive are
  unwrapped automatically

### Mapping it to a collection

| Notion column | Payload field |
| --- | --- |
| `Name` | `title` — `text` |
| `Status` | `status` — `select` |
| `Cover` | `cover` — `upload` |
| `content` | `content` — `richText` (or `textarea` to keep raw Markdown) |

On import, the archive files are uploaded into your upload collection (`media`, or the first
upload-enabled collection) and linked: `upload` fields receive the media ID, `richText` fields
receive a real Lexical `upload` node in place of the Markdown image. The same file referenced by
several rows is uploaded once per import.

### Known limits

- The archive is read in the browser and its files travel to the server inside a single JSON
  request — fine for regular exports, not for multi-gigabyte ones
- Identical files are deduplicated within one import; re-importing the same archive creates new
  `media` documents
- ZIP64 archives (>4 GB or >65535 entries) and Notion's HTML export are not supported
- The archive is read with the native `DecompressionStream` API (Chrome 103+, Safari 16.4+,
  Firefox 113+)

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

The plugin includes tests to ensure reliability — `pnpm test:int` also runs the unit specs next
to the source, such as `src/utils/notion.spec.ts` (CSV parsing, ZIP reading, Notion archive):

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

The plugin exposes an import endpoint at `/api/import`. Files are parsed in the browser, so the
endpoint receives JSON rows, not the file itself:

- **Method**: `POST`
- **Content-Type**: `application/json`

```ts
{
  collection: 'posts',
  // Rows, keyed by column name
  data: [{ Name: 'Write the docs', Status: 'In progress', content: '...' }],
  // Optional: files of an imported archive, "path inside the archive" → data URI
  assets: { 'Tasks 1a2b3c/Write the docs 4d5e6f/cover.png': 'data:image/png;base64,...' },
  settings: {
    mode: 'create' | 'update' | 'upsert',
    compareField: 'id',      // used by update/upsert to find the existing document
    fieldMappings: [{ csvField: 'Name', collectionField: 'title' }],
    locale: 'en',            // optional, defaults to the request locale
  },
}
```

Response:

```ts
{
  success: boolean
  created: number
  updated: number
  errors: string[]          // one entry per failed row
  message: string
  details?: unknown[]       // development only
}
```

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
