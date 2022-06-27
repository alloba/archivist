# Archivist

Scan sources for media and save results. 

Targeted sources will be scanned for all available files, and results will be compared 
with the destination specified during initialization. Anything that does not already exist in 
the destination will be pulled from the source. 

Sources and destinations rely on generic interfaces, so the specific mechanism can vary 
for both the uniqueness check and the download. 
However, the primary use case for this project is to interface with 4Chan boards, to save to 
either a local directory or a S3 bucket. 
So generally expect examples to align with those items. 

## Usage 

This program is run via NPM. 
It relies heavily on runtime parameters for source/destination methods.  

### Examples 

Source and destination can be mixed freely. Below are some examples.

**LocalStorage source and S3 destination**  
`npm run start -- --source.type fs --source.path ./testSourceFiles --destination.type s3 --destination.bucket kaleidoscope-media --destination.path testOutputFiles --destination.region us-east-1 --serious`

**4Chan source to LocalStorage destination**   
`npm run start -- --source.type 4chan --source.path wsg --source.search ygyl --destination.type fs --destination.path .\testOutputFiles --serious`

## Configuration

All parameters listed in this section must be provided as runtime parameters.

Exceptions include: 
- AWS Credentials. These are loaded using the SDK's resolution chain. Meaning credentials file, environment variables, etc.

### Generic Configuration
| Param      | Description                                                                                                                                                                     |
|------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `serious`  | This flag is required to exist before files actually download and save. Leaving this off will still query the source/destination for metadata, but no new items will be placed. |
| `ultradry` | This flag will prevent any outgoing requests, including querying for metadata. This is disabled by default, and is really only for troubleshooting.                             |

### Sources

#### 4Chan 

The OG. Specifying 4Chan as a source will cause this program to reach out to the site when looking for media files. 
This source relies on basic interaction with the api that is provided by the site to pull individual threads and 
their contents. 

Interactions with the 4Chan api are limited by policy to 1 per second. 
So total operations for this source can take a few minutes depending on content. 

**Configuration** 

| Param                     | Description                                                                                                                                                                                      | Example Values          |
|---------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------|
| source.type               | Identifies what type of source to load.                                                                                                                                                          | `4chan`                 |
| source.path               | Which board to use as a source for the media scan.                                                                                                                                               | `wsg`, `gif`            |
| source.search             | The search string to use when looking for threads to pull media from. This would be a substring of the thread title, case-insensitive.                                                           | `ygyl`, `ylyl`, `comfy` |

#### FileSystem

Local file directory as a source. 
File system sources and destinations incur a bit of extra processing due to the need to scan the file when calculating 
md5 hash.

**Configuration**

| Param       | Description                                                                           | Example Values      |
|-------------|---------------------------------------------------------------------------------------|---------------------|
| source.path | Path to the source folder. The folder must already exist, and may be a relative path. | `../source_folder/` |

#### S3 Source

An S3 bucket as a backing source. 
S3 locations assume a properly prepared environment in context of AWS credentials. 
This means that credentials must either be set in a config file, or environment variables must be set properly. 

**Configuration**

| Param         | Description                                                                       | Example Values       |
|---------------|-----------------------------------------------------------------------------------|----------------------|
| source.region | AWS Region that the target S3 bucket is located in.                               | `us-east-1`          |
| source.bucket | S3 bucket to target.                                                              | `kaleidoscope-media` |
| source.path   | Subdirectory to store files in (yeah yeah yeah 'is a key not a directory' shush). | `output_folder/`     |


### Destinations

#### FileSystem

Local storage as a destination.
File system sources and destinations incur a bit of extra processing due to the need to scan the file when calculating
md5 hash.

**Configuration**

| Param            | Description                                                                                | Example Values           |
|------------------|--------------------------------------------------------------------------------------------|--------------------------|
| destination.path | Path to the destination folder. The folder must already exist, and may be a relative path. | `../destination_folder/` |

#### S3

An S3 bucket as a backing source.
S3 locations assume a properly prepared environment in context of AWS credentials.
This means that credentials must either be set in a config file, or environment variables must be set properly.

| Param              | Description                                                                       | Example Values       |
|--------------------|-----------------------------------------------------------------------------------|----------------------|
| destination.region | AWS Region that the target S3 bucket is located in.                               | `us-east-1`          |
| destination.bucket | S3 bucket to target.                                                              | `kaleidoscope-media` |
| destination.path   | Subdirectory to store files in (yeah yeah yeah 'is a key not a directory' shush). | `output_folder/`     |
